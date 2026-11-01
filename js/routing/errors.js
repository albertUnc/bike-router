/** Error raised by any routing engine. `code` lets the UI pick a useful message. */
export class RoutingError extends Error {
  /**
   * @param {string} message
   * @param {'input'|'nokey'|'auth'|'limit'|'network'|'unroutable'|'other'} code
   */
  constructor(message, code = 'other') {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}
