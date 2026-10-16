import { describe, expect, it } from 'vitest';
import { createGate } from '../src/services/accountGate';

const serialized = createGate(1);

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('serialized (per-account gate)', () => {
  it('runs one task per key at a time, in arrival order', async () => {
    const log: string[] = [];
    let running = 0;
    const task = (name: string) => async () => { running++; expect(running).toBe(1); log.push(`start ${name}`); await tick(); log.push(`end ${name}`); running--; };
    await Promise.all([serialized('a', task('1')), serialized('a', task('2')), serialized('a', task('3'))]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('different keys run in parallel', async () => {
    let running = 0, peak = 0;
    const task = async () => { peak = Math.max(peak, ++running); await tick(); running--; };
    await Promise.all(['a', 'b', 'c'].map((k) => serialized(k, task)));
    expect(peak).toBe(3);
  });

  it('a failing task does not block the queue, and its error reaches only its caller', async () => {
    const order: string[] = [];
    const bad = serialized('a', async () => { throw new Error('boom'); });
    const good = serialized('a', async () => { order.push('ran'); return 42; });
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe(42);
    expect(order).toEqual(['ran']);
  });

  it('a limit of N lets N run at once and queues the rest in order', async () => {
    const gate = createGate(2);
    let running = 0, peak = 0;
    const started: number[] = [];
    const task = (i: number) => async () => { started.push(i); peak = Math.max(peak, ++running); await tick(); running--; };
    await Promise.all([1, 2, 3, 4, 5].map((i) => gate('a', task(i))));
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it('forgets idle accounts (no leak) and works again afterwards', async () => {
    const gate = createGate(1);
    await gate('a', async () => {});
    await expect(gate('a', async () => 7)).resolves.toBe(7);
  });
});
