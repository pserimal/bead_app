/**
 * 串行化保存队列：同一时刻最多一个 in-flight 请求。
 *
 * 连续修改会累积多次保存意图，但网络请求必须按序、latest-wins：
 * - submit() 在无 in-flight 时立即发起（返回 true）；in-flight 期间的新修改挂起
 *   （返回 false），记录最新数据。
 * - finish() 在每次请求结束后调用，返回挂起期间累积的「最新」数据（无则 null）。
 *   调用方应携带返回值再次 submit，保证最终落库的是最后一次修改。
 *
 * 这避免了并发 POST 乱序（旧请求晚到覆盖新数据），也保证失败后的后续修改
 * 仍能重新触发（pending 不因失败丢弃）。
 */
export class SerialSaveQueue<T> {
  private inFlight = false;
  private pending: T | null = null;

  /** 有新修改要保存。返回 true = 本次立即发起请求；false = 已挂起（in-flight 中）。 */
  submit(data: T): boolean {
    if (this.inFlight) {
      this.pending = data;
      return false;
    }
    this.inFlight = true;
    this.pending = null;
    return true;
  }

  /** 一次请求结束（无论成败）。返回挂起期间累积的最新数据，无则 null。 */
  finish(): T | null {
    this.inFlight = false;
    const next = this.pending;
    this.pending = null;
    return next;
  }

  /** 无 in-flight 且无挂起数据（全部落库完成）。 */
  get isIdle(): boolean {
    return !this.inFlight && this.pending == null;
  }
}
