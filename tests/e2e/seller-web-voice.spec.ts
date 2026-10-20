import { test, expect } from '@playwright/test';

test.describe('Seller web voice interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      class MockSpeechRecognition {
        lang = '';
        interimResults = false;
        onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          (window as Window & { __mockRecognition?: MockSpeechRecognition }).__mockRecognition = this;
        }
        stop() {
          this.onend?.();
        }
      }
      const speechWindow = window as Window & {
        SpeechRecognition?: new () => MockSpeechRecognition;
        __mockRecognition?: MockSpeechRecognition;
        __emitMockSpeech?: (transcript: string) => void;
      };
      speechWindow.SpeechRecognition = MockSpeechRecognition;
      speechWindow.__emitMockSpeech = transcript => {
        speechWindow.__mockRecognition?.onresult?.({
          results: [[{ transcript }]]
        });
      };
    });
  });

  test('routes browser speech transcript to the seller operation and renders result', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('heading', { name: 'Голосовая касса' }).waitFor();
    await page.getByRole('button', { name: 'Начать запись' }).click();
    await page.evaluate(() => {
      (window as Window & { __emitMockSpeech?: (transcript: string) => void })
        .__emitMockSpeech?.('Сколько осталось помидоров?');
    });

    await expect(page.getByTestId('recognized-transcript')).toHaveText('Сколько осталось помидоров?');
    await expect(page.getByTestId('operation-result')).toContainText('Помидоров осталось 15 килограммов.');
    await expect(page.getByTestId('operation-result')).toContainText('INVENTORY_STOCK_RESOLVED');
    await expect(page.getByRole('status')).toHaveText('Команда обработана');
  });

  test('supports the sale phrase and shows the simulated receipt result', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Текст команды').fill('Продай клиенту два килограмма помидоров и пробей чек');
    await page.getByRole('button', { name: 'Выполнить' }).click();

    await expect(page.getByTestId('operation-result')).toContainText('Продано два килограмма помидоров на сумму 30 дирхам.');
    await expect(page.getByTestId('operation-result')).toContainText('REC-2026-001');
    await expect(page.getByTestId('operation-result')).toContainText('remainingStock');
    await expect(page.getByText(/Демо: распознавание выполняется браузером/)).toBeVisible();
  });

  test('shows a no-match result instead of inventing an operation', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Текст команды').fill('закажи мне билет на поезд');
    await page.getByRole('button', { name: 'Выполнить' }).click();

    await expect(page.getByRole('status')).toHaveText('Команда не распознана. Попробуйте другую формулировку.');
    await expect(page.getByTestId('operation-result')).toHaveCount(0);
  });
});
