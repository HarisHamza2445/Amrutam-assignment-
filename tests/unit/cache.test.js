const { createMemoryStore, cached } = require('../../src/lib/cache');

describe('memory cache', () => {
  it('expires entries', async () => {
    const store = createMemoryStore();
    await store.set('a', { x: 1 }, 0.05);
    expect(await store.get('a')).toEqual({ x: 1 });
    await new Promise((r) => setTimeout(r, 70));
    expect(await store.get('a')).toBeNull();
  });

  it('counts within a window', async () => {
    const store = createMemoryStore();
    expect((await store.incrWindow('k', 60)).count).toBe(1);
    expect((await store.incrWindow('k', 60)).count).toBe(2);
  });

  it('deletes by prefix', async () => {
    const store = createMemoryStore();
    await store.set('doctors:1', 1, 60);
    await store.set('doctors:2', 2, 60);
    await store.set('other', 3, 60);
    await store.delPrefix('doctors:');
    expect(await store.get('doctors:1')).toBeNull();
    expect(await store.get('other')).toBe(3);
  });

  it('only calls the loader on a miss', async () => {
    const store = createMemoryStore();
    const load = jest.fn().mockResolvedValue('value');
    await cached(store, 'key', 60, load);
    await cached(store, 'key', 60, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
