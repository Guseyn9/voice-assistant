import { BackendClient } from './BackendClient';

type ValidationReport = {
  generatedAt: string;
  tester: string;
  build: string;
  scenarioSet: { id: string; name: string; scenarios: Array<{ id: string; name: string; trigger?: string }> } | null;
  executionLog: string;
  verification: { terminal: string; progress: string };
  environment: { userAgent: string; language: string; timezone: string; url: string };
};

export function mountReportPanel(
  host: HTMLElement,
  getReport: (tester: string) => ValidationReport
): void {
  const panel = document.createElement('section');
  panel.dataset.testid = 'validation-report-panel';
  panel.style.cssText = 'margin-top:20px;padding:12px;border:1px solid #bbb;border-radius:6px';
  panel.innerHTML = `
    <h3>Validation Report</h3>
    <div style="display:grid;gap:8px;max-width:560px">
      <label>Backend API URL
        <input data-testid="report-backend-url" type="url" autocomplete="url" placeholder="https://backend.example.com" style="display:block;width:100%;box-sizing:border-box" />
      </label>
      <label>Tester login
        <input data-testid="report-login" autocomplete="username" style="display:block;width:100%;box-sizing:border-box" />
      </label>
      <label>Tester password
        <input data-testid="report-password" type="password" autocomplete="current-password" style="display:block;width:100%;box-sizing:border-box" />
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-testid="report-connect">Connect</button>
        <button type="button" data-testid="report-preview">Refresh preview</button>
        <button type="button" data-testid="report-download">Download JSON</button>
        <button type="button" data-testid="report-send" disabled>Send report</button>
      </div>
      <div data-testid="report-status" role="status" aria-live="polite"></div>
      <label>Report preview
        <textarea data-testid="report-json" readonly rows="12" style="display:block;width:100%;box-sizing:border-box;font-family:monospace"></textarea>
      </label>
    </div>`;
  host.querySelector('main')?.appendChild(panel);

  const query = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const backendUrl = query<HTMLInputElement>('[data-testid="report-backend-url"]');
  const login = query<HTMLInputElement>('[data-testid="report-login"]');
  const password = query<HTMLInputElement>('[data-testid="report-password"]');
  const status = query<HTMLElement>('[data-testid="report-status"]');
  const preview = query<HTMLTextAreaElement>('[data-testid="report-json"]');
  const connectButton = query<HTMLButtonElement>('[data-testid="report-connect"]');
  const previewButton = query<HTMLButtonElement>('[data-testid="report-preview"]');
  const downloadButton = query<HTMLButtonElement>('[data-testid="report-download"]');
  const sendButton = query<HTMLButtonElement>('[data-testid="report-send']');
  const client = new BackendClient();
  let emailId: string | null = null;
  let connectedBaseUrl = '';

  const normalizedBaseUrl = () => backendUrl.value.trim().replace(/\/+$/, '');
  const reportJson = () => {
    const report = getReport(login.value.trim());
    return JSON.stringify(report, null, 2);
  };
  const refreshPreview = () => { preview.value = reportJson(); };

  const updateConnection = (connected: boolean) => {
    sendButton.disabled = !connected || !emailId;
  };

  backendUrl.value = (import.meta as any).env?.VITE_BACKEND_URL || '';
  refreshPreview();

  connectButton.addEventListener('click', async () => {
    const baseUrl = normalizedBaseUrl();
    if (!baseUrl || !login.value.trim() || !password.value) {
      status.textContent = 'Enter the Backend API URL, login, and password.';
      updateConnection(false);
      return;
    }
    try {
      new URL(baseUrl);
    } catch {
      status.textContent = 'Backend API URL is invalid.';
      updateConnection(false);
      return;
    }
    connectButton.disabled = true;
    status.textContent = 'Connecting…';
    emailId = null;
    updateConnection(false);
    try {
      const session = await client.connect(baseUrl, login.value.trim(), password.value);
      if (session.status !== 'connected') {
        status.textContent = 'Authentication failed. Check the URL and credentials.';
        return;
      }
      connectedBaseUrl = baseUrl;
      emailId = await client.getEmailId(baseUrl);
      if (!emailId) {
        status.textContent = 'Connected, but the Backend API did not return a report recipient (site_emails).';
        return;
      }
      status.textContent = 'Connected. Reports can be sent.';
      updateConnection(true);
    } catch {
      status.textContent = 'Could not connect to the Backend API.';
    } finally {
      connectButton.disabled = false;
    }
  });

  previewButton.addEventListener('click', refreshPreview);

  downloadButton.addEventListener('click', () => {
    refreshPreview();
    const blob = new Blob([preview.value], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'validation-report.json';
    link.click();
    URL.revokeObjectURL(url);
    status.textContent = 'Report JSON prepared for download.';
  });

  sendButton.addEventListener('click', async () => {
    if (!emailId || !connectedBaseUrl) {
      status.textContent = 'Connect to the Backend API before sending.';
      updateConnection(false);
      return;
    }
    sendButton.disabled = true;
    status.textContent = 'Sending report…';
    refreshPreview();
    try {
      const sent = await client.sendReport(connectedBaseUrl, JSON.parse(preview.value), emailId);
      status.textContent = sent ? 'Report sent successfully.' : 'Report was not sent. Check the backend mail service and session.';
    } catch {
      status.textContent = 'Report was not sent. Check the backend mail service and session.';
    } finally {
      updateConnection(Boolean(emailId && connectedBaseUrl));
    }
  });
}
