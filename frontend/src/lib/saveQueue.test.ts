import { describe, expect, it } from 'vitest';
import { SerialSaveQueue } from './saveQueue';

describe('SerialSaveQueue（串行化保存队列）', () => {
  it('无 in-flight 时 submit 立即发起；in-flight 期间的新修改挂起', () => {
    const q = new SerialSaveQueue<number>();
    expect(q.submit(1)).toBe(true); // 第一次：发起
    expect(q.isIdle).toBe(false);
    expect(q.submit(2)).toBe(false); // in-flight：挂起
    expect(q.submit(3)).toBe(false); // 继续挂起（最新覆盖旧）
    expect(q.finish()).toBe(3); // 完成后返回最新挂起数据
    expect(q.isIdle).toBe(true);
  });

  it('latest-wins：挂起期间多次修改合并为最新一次', () => {
    const q = new SerialSaveQueue<number>();
    expect(q.submit(1)).toBe(true); // 请求 1 发起
    expect(q.submit(2)).toBe(false); // 挂起
    expect(q.submit(3)).toBe(false); // 挂起，覆盖 2
    expect(q.finish()).toBe(3); // 请求 1 完成 → 补发最新 3
    expect(q.submit(3)).toBe(true); // 补发的 3 发起
    expect(q.finish()).toBe(null); // 完成后无挂起
    expect(q.isIdle).toBe(true);
  });

  it('失败后继续修改仍能成功保存（pending 不丢、可重新触发）', () => {
    const q = new SerialSaveQueue<number>();
    const sent: number[] = [];
    const send = (n: number, fail: boolean) => {
      if (!q.submit(n)) return; // 挂起（in-flight），由 in-flight 的补发覆盖
      const next = q.finish();
      if (fail) {
        // 本次失败：不记 sent，但挂起的数据仍补发（不丢）
        if (next != null) send(next, false);
        return;
      }
      sent.push(n);
      if (next != null) send(next, false);
    };
    send(1, true); // 第一次失败
    send(2, false); // 后续修改成功
    send(3, false);
    expect(sent).toEqual([2, 3]);
    expect(q.isIdle).toBe(true);
  });

  it('空队列 idle 状态正确', () => {
    const q = new SerialSaveQueue<number>();
    expect(q.isIdle).toBe(true);
    q.submit(1);
    expect(q.isIdle).toBe(false);
    q.finish();
    expect(q.isIdle).toBe(true);
  });
});
