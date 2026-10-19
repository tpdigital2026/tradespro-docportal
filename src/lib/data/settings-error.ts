/** A settings change that was refused, with a message safe to show the owner. Kept on its own so scripts can use it. */
export class SettingsError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'limit' | 'not_configured' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}
