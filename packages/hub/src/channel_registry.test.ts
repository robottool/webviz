import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from './channel_registry.js';

describe('ChannelRegistry', () => {
  it('assigns unique global ids and resolves local ids per owner', () => {
    const reg = new ChannelRegistry();
    const a = reg.advertise('connA', 'srcA', 1, 'scan', 'wv/LaserScan', 'json');
    const b = reg.advertise('connB', 'srcB', 1, 'cloud', 'wv/PointCloud', 'binary');

    expect(a.channel.id).not.toBe(b.channel.id);
    expect(reg.resolveLocal('connA', 1)?.name).toBe('scan');
    expect(reg.resolveLocal('connB', 1)?.name).toBe('cloud');
    expect(reg.resolveLocal('connA', 99)).toBeUndefined();
  });

  it('renames both sides on a cross-source name collision', () => {
    const reg = new ChannelRegistry();
    const first = reg.advertise('connA', 'srcA', 1, 'scan', 'wv/LaserScan', 'json');
    expect(first.channel.name).toBe('scan');

    const second = reg.advertise('connB', 'srcB', 1, 'scan', 'wv/LaserScan', 'json');
    expect(second.channel.name).toBe('srcB/scan');
    // The pre-existing channel is prefixed too and reported as renamed.
    expect(second.renamed).toHaveLength(1);
    expect(second.renamed[0].name).toBe('srcA/scan');
  });

  it('carries the latched flag through to list()', () => {
    const reg = new ChannelRegistry();
    reg.advertise('connA', 'srcA', 1, 'map', 'wv/OccupancyGrid', 'json', true);
    reg.advertise('connA', 'srcA', 2, 'scan', 'wv/LaserScan', 'json');

    const byName = new Map(reg.list().map((c) => [c.name, c]));
    expect(byName.get('map')?.latched).toBe(true);
    expect(byName.get('scan')?.latched).toBeUndefined();
  });

  it('removeBySource drops all of a source’s channels', () => {
    const reg = new ChannelRegistry();
    reg.advertise('connA', 'srcA', 1, 'one', 'wv/Custom', 'json');
    reg.advertise('connA', 'srcA', 2, 'two', 'wv/Custom', 'json');
    reg.advertise('connB', 'srcB', 1, 'three', 'wv/Custom', 'json');

    const removed = reg.removeBySource('connA');
    expect(removed.map((c) => c.name).sort()).toEqual(['one', 'two']);
    expect(reg.list().map((c) => c.name)).toEqual(['three']);
    expect(reg.resolveLocal('connA', 1)).toBeUndefined();
  });

  it('unadvertise removes by bare name for the owning source only', () => {
    const reg = new ChannelRegistry();
    reg.advertise('connA', 'srcA', 1, 'scan', 'wv/LaserScan', 'json');
    expect(reg.unadvertise('connB', 'scan')).toBeUndefined();
    expect(reg.unadvertise('connA', 'scan')?.name).toBe('scan');
    expect(reg.list()).toHaveLength(0);
  });
});
