import { describe, test, expect } from 'bun:test';
import { TuiStore } from '../store.js';

describe('TuiStore scroll', () => {
  test('initial state has autoFollow=true and scrollOffset=0', () => {
    const store = new TuiStore();
    expect(store.getState().autoFollow).toBe(true);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test('scrollUp increases offset and disables autoFollow', () => {
    const store = new TuiStore();
    store.scrollUp(10);
    expect(store.getState().scrollOffset).toBe(10);
    expect(store.getState().autoFollow).toBe(false);
  });

  test('scrollDown decreases offset, autoFollow when reaching 0', () => {
    const store = new TuiStore();
    store.scrollUp(20);
    store.scrollDown(10);
    expect(store.getState().scrollOffset).toBe(10);
    expect(store.getState().autoFollow).toBe(false);
    store.scrollDown(10);
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });

  test('scrollDown clamps to 0', () => {
    const store = new TuiStore();
    store.scrollUp(5);
    store.scrollDown(100);
    expect(store.getState().scrollOffset).toBe(0);
  });

  test('scrollToBottom resets offset and enables autoFollow', () => {
    const store = new TuiStore();
    store.scrollUp(50);
    expect(store.getState().scrollOffset).toBe(50);
    store.scrollToBottom();
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });

  test('reset clears scroll state', () => {
    const store = new TuiStore();
    store.scrollUp(100);
    store.reset();
    expect(store.getState().scrollOffset).toBe(0);
    expect(store.getState().autoFollow).toBe(true);
  });
});
