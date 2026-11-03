// Network windows are independent of the small, bounded page/SourceBuffer chunks.
export function createMediaReader(urls, identityRanges, request, now) {
  const WINDOW = 2 * 1024 * 1024;
  let locations = urls,
    selected = urls[0],
    seek = 0,
    cache,
    reading,
    slow = 0,
    cancellations = new Set();
  const identity = new Map(),
    visited = new Set([selected]),
    verified = new Set([selected]);
  const next = () => locations.find((url) => !visited.has(url));
  const owned = (version) => {
    if (version !== seek) throw Error('cancelled');
  };
  const fetch = async (url, start, end, version, deadline) => {
    owned(version);
    const data = new Uint8Array(
      await request(url, {
        range: [start, end],
        binary: true,
        limit: end - start + 1,
        media: true,
        cancellations,
        deadline,
        timeout: next() ? 4000 : 12000,
      }),
    );
    owned(version);
    return data;
  };
  async function verify(url, version, deadline) {
    if (verified.has(url)) return;
    if (identity.size) {
      const end = Math.max(...identityRanges.map((range) => range[1]));
      const data = await fetch(url, 0, end, version, deadline);
      for (const [start, bytes] of identity)
        if (bytes.some((byte, i) => data[start + i] !== byte))
          throw Error('media-changed');
    }
    verified.add(url);
  }
  return {
    get cancellations() {
      return cancellations;
    },
    seek(version) {
      if (version < seek) throw Error('cancelled');
      if (version === seek) return;
      seek = version;
      cache = undefined;
      cancellations.cancelled = true;
      for (const cancel of [...cancellations]) cancel();
      cancellations = new Set();
    },
    replace(fresh) {
      locations = fresh;
      selected = fresh[0];
      cache = undefined;
      visited.clear();
      visited.add(selected);
      verified.clear();
      slow = 0;
    },
    async read(offset, length, end, rate, version, deadline) {
      owned(version);
      if (reading?.version === version) throw Error('busy');
      const token = { version };
      reading = token;
      try {
        if (
          !cache ||
          offset < cache.offset ||
          offset + length > cache.offset + cache.data.length
        ) {
          cache = undefined;
          const window = Math.max(
            length,
            Math.min(WINDOW, rate ? Math.ceil(rate * 2) : WINDOW),
          );
          const last = Math.min(end, offset + window - 1);
          let url = selected;
          // Keep useful bytes from a slow response. Try one unused mirror on the next read.
          if (slow >= 2 && next()) url = next();
          let fallback = url !== selected ? selected : undefined;
          let data,
            expired = false;
          for (let attempt = 0; attempt < locations.length; attempt++) {
            const firstVisit = !visited.has(url);
            visited.add(url);
            try {
              await verify(url, version, deadline);
              const start = now();
              data = await fetch(url, offset, last, version, deadline);
              owned(version);
              const elapsed = now() - start;
              if (url !== selected) slow = 0;
              selected = url;
              slow =
                rate &&
                data.length >= 512 * 1024 &&
                elapsed >= 750 &&
                (data.length * 1000) / elapsed < rate * 1.15
                  ? slow + 1
                  : 0;
              break;
            } catch (error) {
              if (error.message === 'access-expired') expired = true;
              if (firstVisit && error.message === 'busy') visited.delete(url);
              owned(version);
              if (
                ![
                  'network-or-permission-denied',
                  'request-timeout',
                  'http-500',
                  'http-502',
                  'http-503',
                  'http-504',
                  'access-expired',
                  'media-changed',
                  'invalid-range-response',
                ].includes(error.message)
              )
                throw error;
              if (!(next() || fallback))
                throw expired ? Error('access-expired') : error;
              url = next() || fallback;
              if (url === fallback) fallback = undefined;
            }
          }
          if (!data) throw Error('network-or-permission-denied');
          cache = { offset, data };
        }
        const bytes = cache.data.subarray(
          offset - cache.offset,
          offset - cache.offset + length,
        );
        for (const range of identityRanges)
          if (offset === range[0] && length === range[1] - range[0] + 1) {
            const previous = identity.get(offset);
            if (previous && bytes.some((byte, at) => previous[at] !== byte))
              throw Error('media-changed');
            if (!previous) {
              identity.set(offset, bytes.slice());
              verified.clear();
              verified.add(selected);
            }
          }
        return bytes;
      } finally {
        if (reading === token) reading = undefined;
      }
    },
  };
}
