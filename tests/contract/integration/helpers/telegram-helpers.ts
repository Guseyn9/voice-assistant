import type {
  TelegramFileProvider,
  TelegramFileMetadata
} from '../../../../src/platform/telegram-voice-transport';

export class MockTelegramFileProvider implements TelegramFileProvider {
  public files: Map<string, { meta: TelegramFileMetadata; buffer: Buffer }> = new Map();
  public shouldFailDownload = false;
  public downloadCalls = 0;

  public registerFile(fileId: string, filePath: string, mimeType: string, buffer: Buffer) {
    this.files.set(fileId, {
      meta: { fileId, filePath, mimeType, fileSize: buffer.length },
      buffer
    });
  }

  async getFile(fileId: string): Promise<TelegramFileMetadata> {
    const entry = this.files.get(fileId);
    if (!entry) {
      throw new Error(`TELEGRAM_FILE_NOT_FOUND: ${fileId}`);
    }
    return entry.meta;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    this.downloadCalls++;
    if (this.shouldFailDownload) {
      throw new Error('TELEGRAM_FILE_DOWNLOAD_FAILED');
    }
    for (const entry of this.files.values()) {
      if (entry.meta.filePath === filePath) {
        return entry.buffer;
      }
    }
    throw new Error(`TELEGRAM_FILE_NOT_FOUND_BY_PATH: ${filePath}`);
  }
}
