import { test, expect } from '@playwright/test';

test.describe('Validation report panel', () => {
  test('previews a reproducible report and sends it through the configured Backend API', async ({ page }) => {
    const sentRequests: Array<{ url: string; body: string }> = [];

    await page.route('https://backend.test/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/auth') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auth_hash: 'auth-hash' }) });
        return;
      }
      if (url.pathname === '/api/v1/token') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { token: 'session-token', u_hash: 'user-hash' } }) });
        return;
      }
      if (url.pathname === '/api/v1/data/') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { data: { site_emails: { '2': 'reports@example.test' } } } })
        });
        return;
      }
      if (url.pathname === '/api/v1/mail/2/send/') {
        sentRequests.push({ url: request.url(), body: request.postData() || '' });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        return;
      }
      await route.fulfill({ status: 404, body: 'not found' });
    });

    await page.goto(process.env.APP_URL || 'http://localhost:3000');
    const panel = page.getByTestId('validation-report-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('report-login').fill('qa@example.test');
    await panel.getByTestId('report-password').fill('not-a-real-password');
    await panel.getByTestId('report-preview').click();

    const preview = panel.getByTestId('report-json');
    const initialReport = JSON.parse(await preview.inputValue());
    expect(initialReport).toMatchObject({
      tester: 'qa@example.test',
      scenarioSet: null,
      verification: { terminal: 'NOT_RUN', progress: '0/0' }
    });
    expect(initialReport).toHaveProperty('generatedAt');
    expect(initialReport).toHaveProperty('executionLog');
    expect(initialReport).toHaveProperty('environment.userAgent');
    expect(await preview.inputValue()).not.toContain('not-a-real-password');

    await panel.getByTestId('report-backend-url').fill('https://backend.test');
    await panel.getByTestId('report-connect').click();
    await expect(panel.getByTestId('report-status')).toContainText('Connected. Reports can be sent.');
    await expect(panel.getByTestId('report-send')).toBeEnabled();

    await panel.getByTestId('report-send').click();
    await expect(panel.getByTestId('report-status')).toContainText('Report sent successfully.');
    expect(sentRequests).toHaveLength(1);
    const form = new URLSearchParams(sentRequests[0].body);
    const attachment = JSON.parse(form.get('file') || '[]')[0];
    expect(attachment.name).toBe('validation-report.json');
    const attachedReport = Buffer.from(String(attachment.base64).split(',')[1] || '', 'base64').toString('utf8');
    expect(attachedReport).toContain('"tester": "qa@example.test"');
    expect(form.get('subject')).toBe('Validation Report');
  });
});
