import type { ArchiveConnector, Capture } from '@olcys/core';

/**
 * Web archive of the synthetic environment. Public web archives answer the same two questions
 * (which captures of a page exist; give me the page as it was), so a real one plugs in here.
 */
export function createWorldArchiveConnector(base: string): ArchiveConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'world-archive',
    descriptor: { name: 'Archiwum Sieci (dawne wersje stron, środowisko testowe)', hosts: [new URL(root).host], synthetic: true },
    async captures(url, ctx): Promise<Capture[]> {
      const res = await ctx.fetch(`${root}/cdx?url=${encodeURIComponent(url)}`);
      if (res.status !== 200) return [];
      return (JSON.parse(res.body) as { captures: Capture[] }).captures;
    },
  };
}
