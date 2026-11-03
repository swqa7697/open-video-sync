// Network windows are independent of the small, bounded page/SourceBuffer chunks.
export function createMediaReader(urls, identityRanges, request, now) {
  const WINDOW = 2 * 1024 * 1024;
  let locations = urls,
    selected = urls[0],
    seek = 0,
    cache,
    reading,
    slow = 0,
    quick = 0,
    windowLimit = WINDOW,
    cancellations = new Set();
  const identity = new Map(),
    visited = new Set([selected]),
    mismatched = new Set(),
    verified = new Set([selected]);
  const next = () => locations.find((url) => !visited.has(url));
  const owned = (version) => {
    if (version !== seek) throw Error('cancelled');
  };
  const fetch = async (url, start, end, version, deadline, timeout) => {
    owned(version);
    const data = new Uint8Array(
      await request(url, {
        range: [start, end],
        binary: true,
        limit: end - start + 1,
        media: true,
        cancellations,
        deadline,
        timeout,
      }),
    );
    owned(version);
    return data;
  };
  async function verify(url, version, deadline, timeout) {
    if (verified.has(url)) return;
    if (identity.size) {
      const end = Math.max(...identityRanges.map((range) => range[1]));
      const data = await fetch(url, 0, end, version, deadline, timeout);
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
      mismatched.clear();
      slow = 0;
      quick = 0;
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
          let window = Math.max(
            length,
            Math.min(windowLimit, rate ? Math.ceil(rate * 2) : WINDOW),
          );
          let url = selected;
          // Keep useful bytes from a slow response. Try one unused mirror on the next read.
          if (slow >= 2 && next()) url = next();
          // A location can recover after a previous read. Only suppress repeats
          // within this operation, and exclude sources with different bytes.
          const candidates = [
            url,
            ...locations.filter((value) => value !== url && value !== selected),
            ...(url !== selected ? [selected] : []),
          ].filter((value) => !mismatched.has(value));
          let data,
            expired = false;
          for (const [attempt, candidate] of candidates.entries()) {
            url = candidate;
            const firstVisit = !visited.has(url);
            visited.add(url);
            const timeout = attempt < candidates.length - 1 ? 4000 : 12000;
            try {
              await verify(url, version, deadline, timeout);
              const start = now();
              data = await fetch(
                url,
                offset,
                Math.min(end, offset + window - 1),
                version,
                deadline,
                timeout,
              );
              owned(version);
              const elapsed = now() - start;
              if (url !== selected) {
                slow = 0;
                quick = 0;
              }
              selected = url;
              quick =
                data.length >= windowLimit && elapsed < timeout / 4
                  ? quick + 1
                  : 0;
              // Restore read-ahead after recovery so a brief outage does not
              // leave high-latency playback using small ranges indefinitely.
              if (quick >= 2) {
                windowLimit = Math.min(WINDOW, windowLimit * 2);
                quick = 0;
              }
              slow =
                rate &&
                data.length >= 512 * 1024 &&
                elapsed >= 750 &&
                (data.length * 1000) / elapsed < rate * 1.15
                  ? slow + 1
                  : 0;
              break;
            } catch (error) {
              owned(version);
              if (error.message === 'access-expired') expired = true;
              if (error.message === 'media-changed') mismatched.add(url);
              if (error.message === 'request-timeout') {
                quick = 0;
                // Smaller ranges can finish within the same finite deadline.
                // Retain this cap across page retries instead of repeating a
                // high-bitrate read-ahead window that never completes.
                window = Math.max(256 * 1024, length, Math.floor(window / 2));
                windowLimit = Math.min(windowLimit, window);
              }
              if (firstVisit && error.message === 'busy') visited.delete(url);
              if (
                ![
                  'network-or-permission-denied',
                  'request-timeout',
                  'access-expired',
                  'media-changed',
                  'invalid-range-response',
                ].includes(error.message) &&
                !/^http-(404|408|5[0-9]{2})$/.test(error.message)
              )
                throw error;
              if (attempt === candidates.length - 1)
                throw expired ? Error('access-expired') : error;
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
