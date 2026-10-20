import { useMemo, useRef, useState } from 'react';
import scenarioFixture from '../scenario-sc-001-vegetable-stall.json';
import { DialogueStateManager } from './platform/dialogue-manager';
import { VoiceChannel, type ScenarioSet } from './platform/voice-channel';
import './seller-voice.css';

type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechErrorEvent = { error?: string };

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

type ScenarioFixture = {
  id: string;
  name?: string;
  steps: Array<{
    kind: 'emit' | 'end';
    event?: { type: string; payload: Record<string, unknown> };
  }>;
};

function buildSellerScenarioSet(): ScenarioSet {
  const fixture = scenarioFixture as unknown as {
    version: number;
    id: string;
    name?: string;
    scenarios: ScenarioFixture[];
  };
  const source = fixture.scenarios[0];
  const operations = source.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === 'emit' && step.event?.type === 'VOICE_INPUT_RECEIVED');

  return {
    version: fixture.version,
    id: fixture.id,
    name: fixture.name,
    scenarios: operations.map(({ step, index }) => {
      const input = step.event!;
      const nextOutput = source.steps.slice(index + 1).find(
        candidate => candidate.kind === 'emit' && candidate.event?.type !== 'VOICE_INPUT_RECEIVED'
      );
      const payload = input.payload;
      const phrase = String(payload.text ?? '');
      const aliases = Array.isArray(payload.aliases) ? payload.aliases.map(String) : [];
      if (!nextOutput?.event || !phrase || typeof payload.action !== 'string') {
        throw new Error(`Invalid seller voice scenario at step ${index}`);
      }

      return {
        id: String(payload.stepId ?? `seller-operation-${index}`),
        intent: payload.action,
        expectedPhrase: phrase,
        triggerPhrases: aliases,
        steps: [{ kind: 'emit' as const, event: nextOutput.event }, { kind: 'end' as const }]
      };
    })
  };
}

const sellerScenarioSet = buildSellerScenarioSet();
const sellerIdentity = { ownerId: 'seller-web-demo', sessionId: 'seller-register-01' };

function App() {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [message, setMessage] = useState('Готово к голосовой команде');
  const [lastEvent, setLastEvent] = useState<{ type: string; payload: Record<string, unknown> } | null>(null);
  const [manualCommand, setManualCommand] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const voiceChannel = useMemo(() => {
    const manager = new DialogueStateManager({
      enableAutoExpiryScheduler: false,
      actionDispatcher: async event => {
        setLastEvent({ type: event.type, payload: event.payload });
        return { status: 'SUCCEEDED', executionId: `demo-${Date.now()}`, attempt: 1 };
      }
    });
    const channel = new VoiceChannel(manager);
    channel.registerScenarioSet(sellerScenarioSet);
    return channel;
  }, []);

  const handleTranscript = async (rawTranscript: string) => {
    const cleanTranscript = rawTranscript.trim();
    if (!cleanTranscript) {
      setMessage('Не удалось получить текст команды');
      return;
    }
    setTranscript(cleanTranscript);
    setLastEvent(null);
    setMessage('Обрабатываю команду…');
    try {
      const result = await voiceChannel.handleIncomingVoice(cleanTranscript, sellerIdentity);
      if (result?.status === 'NO_MATCH') {
        setMessage('Команда не распознана. Попробуйте другую формулировку.');
      } else if (result?.status === 'AMBIGUOUS_INTENT') {
        setMessage('Команда неоднозначна. Уточните формулировку.');
      } else if (result?.status === 'CONTEXT_REQUIRED') {
        setMessage('Для этой команды не хватает контекста.');
      } else if (result?.status === 'RESOLVED' || result?.status === 'COMPLETED' || result?.status === 'SUCCEEDED') {
        setMessage('Команда обработана');
      } else if (result?.status) {
        setMessage(`Результат: ${result.status}`);
      } else {
        setMessage('Команда обработана');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ошибка обработки команды');
    }
  };

  const startListening = () => {
    const speechWindow = window as SpeechWindow;
    const SpeechRecognitionConstructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionConstructor) {
      setMessage('В этом браузере нет распознавания речи. Используйте поле тестовой команды.');
      return;
    }

    const recognition = new SpeechRecognitionConstructor();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.onresult = event => {
      const spokenText = event.results[0]?.[0]?.transcript ?? '';
      void handleTranscript(spokenText);
    };
    recognition.onerror = event => {
      setMessage(`Ошибка микрофона или распознавания: ${event.error ?? 'неизвестная ошибка'}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    setMessage('Слушаю…');
    try {
      recognition.start();
    } catch (error) {
      setListening(false);
      setMessage(error instanceof Error ? error.message : 'Не удалось включить микрофон');
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  return (
    <main className="seller-app">
      <header className="seller-header">
        <div>
          <p className="eyebrow">РАБОЧЕЕ МЕСТО ПРОДАВЦА</p>
          <h1>Голосовая касса</h1>
          <p className="subtitle">Команды для остатков, цен и продажи товара</p>
        </div>
        <span className="status-pill"><span className="status-dot" /> Демонстрационный контур</span>
      </header>

      <section className="voice-panel" aria-labelledby="voice-title">
        <div className="panel-copy">
          <h2 id="voice-title">Голосовая команда</h2>
          <p>Нажмите кнопку и произнесите команду на русском языке.</p>
        </div>
        <button className="mic-button" onClick={listening ? stopListening : startListening} aria-pressed={listening}>
          <span aria-hidden="true">{listening ? '■' : '●'}</span>
          {listening ? 'Остановить запись' : 'Начать запись'}
        </button>
        <p className="status-message" role="status" aria-live="polite">{message}</p>
        {transcript && (
          <div className="transcript-card">
            <span className="field-label">Последняя команда</span>
            <p data-testid="recognized-transcript">{transcript}</p>
          </div>
        )}
      </section>

      <section className="operations-panel" aria-labelledby="operations-title">
        <h2 id="operations-title">Поддерживаемые операции</h2>
        <div className="operation-grid">
          <article><span className="operation-number">01</span><h3>Проверить остаток</h3><p>«Сколько осталось помидоров?»</p></article>
          <article><span className="operation-number">02</span><h3>Оформить продажу</h3><p>«Продай клиенту два килограмма помидоров и пробей чек»</p></article>
          <article><span className="operation-number">03</span><h3>Изменить цену</h3><p>«Поставь огурцы по 20 дирхам за килограмм»</p></article>
          <article><span className="operation-number">04</span><h3>Обновить остаток</h3><p>«Картофеля осталось 10 килограммов»</p></article>
        </div>
      </section>

      <section className="test-panel" aria-labelledby="test-command-title">
        <h2 id="test-command-title">Проверка без микрофона</h2>
        <form onSubmit={event => { event.preventDefault(); void handleTranscript(manualCommand); }}>
          <label htmlFor="manual-command">Текст команды</label>
          <div className="command-row">
            <input id="manual-command" value={manualCommand} onChange={event => setManualCommand(event.target.value)} placeholder="Введите фразу из примеров" />
            <button type="submit" className="secondary-button">Выполнить</button>
          </div>
        </form>
      </section>

      <section className="result-panel" aria-labelledby="result-title">
        <h2 id="result-title">Результат операции</h2>
        {lastEvent ? (
          <div data-testid="operation-result" className="result-card">
            <div className="result-heading"><span className="success-mark">✓</span><strong>{lastEvent.payload.speech ? String(lastEvent.payload.speech) : lastEvent.type}</strong></div>
            <dl>
              <div><dt>Событие</dt><dd>{lastEvent.type}</dd></div>
              {Object.entries(lastEvent.payload).filter(([key]) => key !== 'speech').map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>
              ))}
            </dl>
          </div>
        ) : (
          <p className="empty-result">Здесь появится результат после распознанной команды.</p>
        )}
      </section>

      <p className="demo-notice">Демо: распознавание выполняется браузером, а результат операции имитируется. Реальный кассовый backend и печать чека пока не подключены.</p>
    </main>
  );
}

export default App;
