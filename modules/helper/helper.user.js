// ==UserScript==
// @name OVS Bilibili {{ORIGIN}}
// @namespace ovs-bilibili-{{ORIGIN}}
// @version {{HELPER_VERSION}}
// @description Browser-local Bilibili playback for one OVS instance
// @match {{MATCH}}
// @noframes
// @run-at document-start
// @sandbox JavaScript
// @grant GM_xmlhttpRequest
// @grant unsafeWindow
// @connect api.bilibili.com
// @connect bilivideo.com
// @connect upos-hz-mirrorakam.akamaized.net
// @updateURL none
// @downloadURL none
// ==/UserScript==

(() => {
  'use strict';
  /* OVS_BRIDGE_JSON */
  /* OVS_MEDIA_CODECS */
  /* OVS_MEDIA_DELIVERY */
  const ORIGIN = '{{ORIGIN}}';
  const pageWindow = unsafeWindow;
  if (location.origin !== ORIGIN || pageWindow.top !== pageWindow.self) return;
  const MAX = 256 * 1024,
    DEADLINE = 12000,
    RESOLUTION_DEADLINE = 24000;
  const handles = new Map(),
    pending = new Set(),
    streams = new WeakMap();
  let client,
    generation = 0,
    active = 0,
    serial = 0,
    calls = 0,
    byteCalls = 0,
    windowStart = performance.now();
  const metrics = {
    requests: 0,
    bytes: 0,
    peakRequests: 0,
    rejected: 0,
    refreshes: 0,
    maxResponseBytes: 0,
    oversizeBytes: 0,
  };
  const publicError = (error) =>
    /^(destination-denied|busy|cancelled|stale-generation|request-timeout|response-too-large|network-or-permission-denied|redirect-denied|access-expired|http-[0-9]{3}|invalid-range-response|unavailable|login-required|platform-access-denied|part-unavailable|unsupported-stream|unsupported-codec|invalid-danmaku|invalid-request|helper-incompatible|invalid-media|unknown-handle|invalid-range|media-changed|invalid-segment|rate-limited)$/.test(
      error.message,
    )
      ? error.message
      : 'platform-response-invalid';
  function safeURL(raw, media = false) {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
      throw Error('destination-denied');
    if (media) {
      if (
        (!/(^|\.)bilivideo\.com$/.test(u.hostname) &&
          u.hostname !== 'upos-hz-mirrorakam.akamaized.net') ||
        !u.pathname.startsWith('/upgcxcode/')
      )
        throw Error('destination-denied');
    } else if (
      u.hostname !== 'api.bilibili.com' ||
      ![
        '/x/web-interface/view',
        '/x/player/playurl',
        '/x/web-interface/nav',
        '/x/v2/dm/web/seg.so',
      ].includes(u.pathname)
    )
      throw Error('destination-denied');
    return u.href;
  }
  function mediaURLs(track) {
    const backups = track.backupUrl || track.backup_url;
    const locations = [];
    for (const raw of [
      track.baseUrl || track.base_url,
      ...(Array.isArray(backups) ? backups : []),
    ]) {
      if (typeof raw !== 'string') continue;
      try {
        const url = safeURL(raw, true);
        if (!locations.includes(url)) locations.push(url);
        if (locations.length === 3) break;
      } catch {
        // Provider locations must pass the same checks before any request.
      }
    }
    if (!locations.length) throw Error('destination-denied');
    return locations;
  }
  function request(
    url,
    {
      range,
      binary = false,
      limit = 1024 * 1024,
      media = false,
      cancellations,
      deadline = Infinity,
      timeout = DEADLINE,
    } = {},
  ) {
    safeURL(url, media);
    if (cancellations?.cancelled) throw Error('cancelled');
    const requestTimeout = Math.min(
      DEADLINE,
      timeout,
      deadline - performance.now(),
    );
    if (requestTimeout <= 0) throw Error('request-timeout');
    if (active >= 2) throw Error('busy');
    const mine = generation;
    active++;
    metrics.requests++;
    metrics.peakRequests = Math.max(metrics.peakRequests, active);
    return new Promise((resolve, reject) => {
      let settled = false,
        timer,
        controller;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        cancellations?.delete(cancel);
        active--;
        if (error) reject(Error(error));
        else if (mine !== generation) reject(Error('stale-generation'));
        else resolve(value);
      };
      const cancel = () => {
        finish('cancelled');
        controller?.abort();
      };
      pending.add(cancel);
      cancellations?.add(cancel);
      timer = setTimeout(() => {
        finish('request-timeout');
        controller?.abort();
      }, requestTimeout);
      function bounds(event) {
        if (
          event.loaded > limit ||
          (event.lengthComputable && event.total > limit)
        ) {
          metrics.oversizeBytes = event.loaded;
          finish('response-too-large');
          controller?.abort();
        }
      }
      try {
        controller = GM_xmlhttpRequest({
          method: 'GET',
          url,
          nocache: true,
          redirect: 'error',
          responseType: binary ? 'arraybuffer' : 'text',
          headers: {
            Referer: 'https://www.bilibili.com/',
            ...(range ? { Range: `bytes=${range[0]}-${range[1]}` } : {}),
          },
          timeout: requestTimeout,
          onprogress: bounds,
          onreadystatechange: (r) => {
            if (r.readyState === 2) {
              const length = Number(
                r.responseHeaders?.match(
                  /(?:^|\n)content-length:\s*(\d+)/i,
                )?.[1],
              );
              if (length > limit) {
                metrics.oversizeBytes = 0;
                finish('response-too-large');
                controller?.abort();
              }
            }
          },
          onerror: () => finish('network-or-permission-denied'),
          ontimeout: () => finish('request-timeout'),
          onabort: () => finish('cancelled'),
          onload: (r) => {
            try {
              safeURL(r.finalUrl || url, media);
              if (
                r.finalUrl &&
                new URL(r.finalUrl).origin !== new URL(url).origin
              )
                throw Error('redirect-denied');
              if (r.status !== (range ? 206 : 200))
                throw Error(
                  r.status === 403 || r.status === 410
                    ? 'access-expired'
                    : `http-${r.status}`,
                );
              const data = binary ? r.response : r.responseText,
                size = binary
                  ? data.byteLength
                  : new TextEncoder().encode(data).byteLength;
              metrics.maxResponseBytes = Math.max(
                metrics.maxResponseBytes,
                size,
              );
              if (size > limit) {
                metrics.oversizeBytes = size;
                throw Error('response-too-large');
              }
              if (range && size !== range[1] - range[0] + 1)
                throw Error('invalid-range-response');
              if (range) {
                const contentRange = r.responseHeaders?.match(
                  /(?:^|\n)content-range:\s*bytes (\d+)-(\d+)\/(\d+)\s*(?:\r?\n|$)/i,
                );
                if (
                  !contentRange ||
                  Number(contentRange[1]) !== range[0] ||
                  Number(contentRange[2]) !== range[1] ||
                  !Number.isSafeInteger(Number(contentRange[3])) ||
                  Number(contentRange[3]) <= range[1]
                )
                  throw Error('invalid-range-response');
              }
              metrics.bytes += size;
              finish(undefined, data);
            } catch (e) {
              finish(e.message);
            }
          },
        });
      } catch {
        finish('network-or-permission-denied');
      }
    });
  }
  async function api(path, params, cancellations, deadline) {
    const x = JSON.parse(
      await request(
        `https://api.bilibili.com${path}?${new URLSearchParams(params)}`,
        { cancellations, deadline },
      ),
    );
    if (x.code !== 0)
      throw Error(
        x.code === -404
          ? 'unavailable'
          : x.code === -101
            ? 'login-required'
            : 'platform-access-denied',
      );
    return x.data;
  }
  // Return display/selection metadata only. Provider objects stay in the helper.
  function episodeList(view, bvid, part) {
    const episodes = [],
      seen = new Set();
    const text = (value) => {
      if (typeof value !== 'string') return '';
      let result = '';
      for (const c of value) {
        const code = c.codePointAt(0);
        if (code < 32 || (code >= 127 && code <= 159)) continue;
        if (result.length + c.length > 160) break;
        result += c;
      }
      return result;
    };
    const add = (id, page, title) => {
      if (
        !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(id) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 10000
      )
        return;
      const key = `${id}:${page}`;
      if (seen.has(key)) return;
      seen.add(key);
      episodes.push({ bvid: id, part: page, title: text(title) || `P${page}` });
    };
    const sections = view.ugc_season?.sections;
    if (Array.isArray(sections) && sections.length <= 100) {
      for (const section of sections) {
        if (!Array.isArray(section?.episodes) || section.episodes.length > 500)
          return;
        for (const episode of section.episodes) {
          if (!episode) continue;
          const pages = Array.isArray(episode.pages)
            ? episode.pages
            : [episode.page];
          if (pages.length > 500) return;
          for (const page of pages) {
            if (!page) continue;
            add(
              episode.bvid,
              page.page,
              pages.length > 1
                ? `${text(episode.title)} · ${text(page.part)}`
                : episode.title || page.part,
            );
            if (episodes.length > 500) return;
          }
        }
      }
    }
    let title = text(view.ugc_season?.title);
    if (!episodes.some((e) => e.bvid === bvid && e.part === part)) {
      episodes.length = 0;
      seen.clear();
      if (view.pages.length > 500) return;
      for (const page of view.pages) add(bvid, page.page, page.part);
      title = text(view.title);
    }
    if (episodes.length > 1) return { title, episodes };
  }
  function supportsTrack(track, mime) {
    if (
      (track.mimeType || track.mime_type) !== mime ||
      typeof track.codecs !== 'string' ||
      track.codecs.length > 60
    )
      return false;
    try {
      return (
        pageWindow.MediaSource?.isTypeSupported(
          `${mime}; codecs="${track.codecs}"`,
        ) === true
      );
    } catch {
      return false;
    }
  }
  async function resolve(
    bvid,
    part,
    selectedQuality = 0,
    currentTracks,
    cancellations,
    deadline = performance.now() + RESOLUTION_DEADLINE,
  ) {
    if (
      !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid) ||
      !Number.isInteger(part) ||
      part < 1 ||
      part > 10000
    )
      throw Error('invalid-media');
    const view = await api(
      '/x/web-interface/view',
      { bvid },
      cancellations,
      deadline,
    );
    if (!Array.isArray(view?.pages) || view.pages.length > 10000)
      throw Error('invalid-media');
    const page = view.pages.find((p) => p.page === part);
    if (!page) throw Error('part-unavailable');
    if (
      !Number.isSafeInteger(page.cid) ||
      page.cid < 1 ||
      !Array.isArray(view.pages) ||
      view.pages.length > 10000
    )
      throw Error('invalid-media');
    const play = await api(
      '/x/player/playurl',
      {
        bvid,
        cid: String(page.cid),
        qn: String(selectedQuality || 127),
        // DASH plus AV1. DASH responses also include HEVC and AVC representations.
        fnval: String(16 | 2048),
        fourk: '1',
      },
      cancellations,
      deadline,
    );
    if (
      !Array.isArray(play.dash?.video) ||
      !play.dash.video.length ||
      !Array.isArray(play.dash?.audio) ||
      !play.dash.audio.length
    )
      throw Error('unsupported-stream');
    const playable = play.dash.video.filter(
      (t) =>
        t &&
        Number.isSafeInteger(t.id) &&
        t.id > 0 &&
        t.id <= 127 &&
        videoCodecRank(t.codecs) >= 0 &&
        supportsTrack(t, 'video/mp4'),
    );
    playable.sort(
      (a, b) =>
        b.id - a.id || videoCodecRank(a.codecs) - videoCodecRank(b.codecs),
    );
    const matches = (track, current) =>
      track.id === current.id && track.codecs === current.codec;
    const audioTracks = play.dash.audio.filter(
      (t) =>
        t &&
        typeof t.codecs === 'string' &&
        /^mp4a\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/.test(t.codecs) &&
        supportsTrack(t, 'audio/mp4'),
    );
    const video = currentTracks
      ? playable.find((t) => matches(t, currentTracks[0]))
      : playable.find((t) => t.id === selectedQuality) || playable[0];
    const audio = currentTracks
      ? audioTracks.find((t) => matches(t, currentTracks[1]))
      : audioTracks[0];
    if (currentTracks && (!video || !audio)) throw Error('media-changed');
    if (!video || !audio) throw Error('unsupported-codec');
    if (
      !Number.isFinite(play.timelength) ||
      play.timelength < 1 ||
      play.timelength > 604800000
    )
      throw Error('invalid-media');
    const tracks = [video, audio].map((t) => ({
      urls: mediaURLs(t),
      id: t.id,
      codec: t.codecs,
      mime: t.mimeType || t.mime_type,
      init: (
        t.SegmentBase?.Initialization ||
        t.segment_base?.initialization ||
        ''
      )
        .split('-')
        .map(Number),
      index: (t.SegmentBase?.indexRange || t.segment_base?.index_range || '')
        .split('-')
        .map(Number),
    }));
    if (
      tracks.some(
        (t) =>
          !['video/mp4', 'audio/mp4'].includes(t.mime) ||
          !/^[-A-Za-z0-9.]{1,60}$/.test(t.codec) ||
          [t.init, t.index].some(
            (r) =>
              r.length !== 2 ||
              !r.every(Number.isSafeInteger) ||
              r[0] < 0 ||
              r[1] < r[0] ||
              r[1] > 65535,
          ),
      )
    )
      throw Error('invalid-media');
    const playlist = episodeList(view, bvid, part);
    return {
      bvid,
      cid: String(page.cid),
      part,
      duration: play.timelength / 1000,
      title: String(view.title).slice(0, 160),
      parts: view.pages.length,
      ...(playlist ? { playlist } : {}),
      quality: video.id,
      qualities: [...new Set(playable.map((t) => t.id))].sort((a, b) => b - a),
      tracks,
    };
  }
  function describe(media) {
    return {
      ...media,
      tracks: media.tracks.map((t) => ({
        id: t.id,
        codec: t.codec,
        mime: t.mime,
        init: t.init,
        index: t.index,
      })),
    };
  }
  function protobuf(bytes, maxFields = 30000) {
    let at = 0;
    const end = bytes.length;
    const varint = () => {
      let n = 0,
        scale = 1;
      for (let i = 0; i < 10 && at < end; i++) {
        const b = bytes[at++];
        n += (b & 127) * scale;
        if (!(b & 128)) return n;
        scale *= 128;
      }
      throw Error('invalid-danmaku');
    };
    const fields = [];
    while (at < end) {
      const key = varint(),
        wire = key & 7,
        field = Math.floor(key / 8);
      if (!Number.isSafeInteger(key) || field < 1 || fields.length >= maxFields)
        throw Error('invalid-danmaku');
      let value;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const n = varint();
        if (!Number.isSafeInteger(n) || n > end - at)
          throw Error('invalid-danmaku');
        value = bytes.subarray(at, at + n);
        at += n;
      } else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else throw Error('invalid-danmaku');
      if (at > end) throw Error('invalid-danmaku');
      fields.push([field, value]);
    }
    return fields;
  }
  async function dispatch(q) {
    const allowed = {
      hello: ['version'],
      probe: ['version'],
      preview: ['bvid', 'part'],
      session: [],
      open: [
        'bvid',
        'part',
        'generation',
        ...(Object.hasOwn(q, 'quality') ? ['quality'] : []),
      ],
      bytes: ['handle', 'track', 'offset', 'length', 'generation'],
      seek: ['handle', 'seek', 'generation'],
      danmaku: ['handle', 'segment', 'generation'],
      dispose: ['generation'],
      metrics: [],
    };
    if (q.op === 'bytes')
      allowed.bytes.push(
        ...['end', 'rate', 'seek'].filter((key) => Object.hasOwn(q, key)),
      );
    if (
      !Object.hasOwn(allowed, q.op) ||
      Object.keys(q).length !== allowed[q.op].length + 4 ||
      Object.keys(q).some(
        (k) => !['channel', 'id', 'op', 'client', ...allowed[q.op]].includes(k),
      )
    )
      throw Error('invalid-request');
    if (q.op === 'hello' || q.op === 'probe') {
      if (q.version !== 1) throw Error('helper-incompatible');
      if (q.op === 'hello' && client !== q.client) {
        for (const cancel of [...pending]) cancel();
        handles.clear();
        generation = 0;
        client = q.client;
      }
      return {
        version: 1,
        helper: '{{HELPER_VERSION}}',
        maxChunk: MAX,
        build: '{{HELPER_BUILD}}',
      };
    }
    // Inspect a candidate without taking ownership, cancelling playback, or creating a handle.
    if (q.op === 'preview') return describe(await resolve(q.bvid, q.part));
    if (q.client !== client) throw Error('stale-generation');
    if (q.op === 'metrics') return metrics;
    if (q.op === 'session') {
      try {
        const n = await api('/x/web-interface/nav', {});
        return { loggedIn: n.isLogin === true };
      } catch (e) {
        if (e.message === 'login-required') return { loggedIn: false };
        throw e;
      }
    }
    if (q.op === 'dispose' || q.op === 'open') {
      if (!Number.isSafeInteger(q.generation) || q.generation <= generation)
        throw Error('stale-generation');
      generation = q.generation;
      for (const cancel of [...pending]) cancel();
      handles.clear();
      if (q.op === 'dispose') return { disposed: true };
      if (
        Object.hasOwn(q, 'quality') &&
        (!Number.isSafeInteger(q.quality) || q.quality < 1 || q.quality > 127)
      )
        throw Error('invalid-request');
      const mine = generation,
        media = await resolve(q.bvid, q.part, q.quality);
      if (mine !== generation) throw Error('stale-generation');
      const handle = `h${++serial}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
      handles.set(handle, media);
      streams.set(media, {
        seek: 0,
        operations: new Map(),
        readers: media.tracks.map((track) =>
          createMediaReader(
            track.urls,
            [track.init, track.index],
            request,
            () => performance.now(),
          ),
        ),
      });
      return {
        ...describe(media),
        handle,
      };
    }
    if (q.generation !== generation) throw Error('stale-generation');
    const media = handles.get(q.handle);
    if (!media) throw Error('unknown-handle');
    const stream = streams.get(media);
    const advanceSeek = (seek) => {
      if (!Number.isSafeInteger(seek) || seek < 0)
        throw Error('invalid-request');
      if (seek < stream.seek) throw Error('cancelled');
      if (seek > stream.seek) {
        stream.seek = seek;
        for (const reader of stream.readers) reader.seek(seek);
      }
    };
    if (q.op === 'seek') {
      advanceSeek(q.seek);
      return { cancelled: true };
    }
    if (q.op === 'bytes') {
      if (
        !Number.isInteger(q.track) ||
        q.track < 0 ||
        q.track >= media.tracks.length ||
        !Number.isSafeInteger(q.offset) ||
        q.offset < 0 ||
        !Number.isInteger(q.length) ||
        q.length < 1 ||
        q.length > MAX ||
        !Number.isSafeInteger(q.offset + q.length - 1) ||
        (q.end !== undefined &&
          (!Number.isSafeInteger(q.end) || q.end < q.offset + q.length - 1)) ||
        (q.rate !== undefined &&
          (!Number.isFinite(q.rate) ||
            q.rate < 1 ||
            q.rate > 128 * 1024 * 1024))
      )
        throw Error('invalid-range');
      advanceSeek(Object.hasOwn(q, 'seek') ? q.seek : 0);
      const reader = stream.readers[q.track],
        seek = q.seek ?? 0,
        deadline = performance.now() + DEADLINE,
        read = () =>
          reader.read(
            q.offset,
            q.length,
            q.end ?? q.offset + q.length - 1,
            q.rate,
            seek,
            deadline,
          );
      if (stream.operations.get(q.track)?.seek === seek) throw Error('busy');
      const operation = { seek };
      stream.operations.set(q.track, operation);
      try {
        let data;
        try {
          data = await read();
        } catch (e) {
          if (e.message !== 'access-expired') throw e;
          const fresh = await resolve(
            media.bvid,
            media.part,
            media.quality,
            media.tracks,
            reader.cancellations,
            deadline,
          );
          if (
            q.generation !== generation ||
            q.client !== client ||
            handles.get(q.handle) !== media ||
            stream.seek !== seek
          )
            throw Error('stale-generation');
          if (
            fresh.cid !== media.cid ||
            fresh.duration !== media.duration ||
            fresh.tracks.some(
              (t, i) =>
                t.codec !== media.tracks[i].codec ||
                t.id !== media.tracks[i].id ||
                t.init.some(
                  (value, at) => value !== media.tracks[i].init[at],
                ) ||
                t.index.some(
                  (value, at) => value !== media.tracks[i].index[at],
                ),
            )
          )
            throw Error('media-changed');
          media.tracks[q.track] = fresh.tracks[q.track];
          reader.replace(fresh.tracks[q.track].urls);
          metrics.refreshes++;
          data = await read();
        }
        let text = '';
        for (const b of data) text += String.fromCharCode(b);
        return { base64: btoa(text) };
      } finally {
        if (stream.operations.get(q.track) === operation)
          stream.operations.delete(q.track);
      }
    }
    if (q.op === 'danmaku') {
      if (
        !Number.isInteger(q.segment) ||
        q.segment < 1 ||
        q.segment > Math.ceil(media.duration / 360)
      )
        throw Error('invalid-segment');
      const buffer = await request(
        `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${media.cid}&segment_index=${q.segment}`,
        { binary: true, limit: 8 * 1024 * 1024 },
      );
      const comments = [];
      let commentBytes = 0;
      for (const [field, value] of protobuf(new Uint8Array(buffer))) {
        if (field !== 1 || !(value instanceof Uint8Array)) continue;
        const f = new Map(protobuf(value, 64)),
          text = new TextDecoder()
            .decode((f.get(7) || new Uint8Array()).subarray(0, 800))
            .slice(0, 200)
            .split('')
            .filter((c) => {
              const n = c.charCodeAt(0);
              return n >= 32 && !(n >= 127 && n <= 159);
            })
            .join('');
        const time = Number(f.get(2)) / 1000,
          mode = Number(f.get(3)),
          color = Number(f.get(5));
        if (
          text &&
          Number.isFinite(time) &&
          time >= 0 &&
          time <= media.duration &&
          [1, 4, 5].includes(mode)
        ) {
          const comment = { time, mode, color: color & 0xffffff, text };
          commentBytes +=
            new TextEncoder().encode(JSON.stringify(comment)).byteLength + 1;
          if (commentBytes > 300 * 1024) break;
          comments.push(comment);
        }
        if (comments.length >= 1500) break;
      }
      return { comments };
    }
  }
  window.addEventListener('message', async (event) => {
    const source =
      event.source && typeof XPCNativeWrapper === 'function'
        ? XPCNativeWrapper.unwrap(event.source)
        : event.source;
    if (
      source !== pageWindow ||
      event.origin !== ORIGIN ||
      typeof event.data !== 'string' ||
      event.data.length > 2048 ||
      new TextEncoder().encode(event.data).byteLength > 2048
    )
      return;
    let q;
    try {
      q = parseBridgeJSON(event.data, 2048);
    } catch {
      return;
    }
    if (
      q?.channel !== 'ovs-bilibili-request' ||
      !Number.isSafeInteger(q.id) ||
      q.id < 1 ||
      !/^[a-f0-9]{32}$/.test(q.client)
    )
      return;
    if (performance.now() - windowStart > 1000) {
      windowStart = performance.now();
      calls = 0;
      byteCalls = 0;
    }
    let answer;
    try {
      if (
        (q.op === 'bytes' ? ++byteCalls > 128 : ++calls > 32) &&
        !(
          (q.op === 'dispose' || q.op === 'seek') &&
          q.client === client &&
          Number.isSafeInteger(q.generation) &&
          (q.op === 'dispose'
            ? q.generation > generation
            : q.generation === generation)
        )
      )
        throw Error('rate-limited');
      answer = { ok: true, value: await dispatch(q) };
    } catch (e) {
      metrics.rejected++;
      answer = { ok: false, error: publicError(e) };
    }
    const response = JSON.stringify({
      channel: 'ovs-bilibili-response',
      client: q.client,
      id: q.id,
      ...answer,
    });
    window.postMessage(
      new TextEncoder().encode(response).byteLength <= 384 * 1024
        ? response
        : JSON.stringify({
            channel: 'ovs-bilibili-response',
            client: q.client,
            id: q.id,
            ok: false,
            error: 'reply-too-large',
          }),
      ORIGIN,
    );
  });
  window.addEventListener(
    'pagehide',
    () => {
      generation++;
      for (const cancel of [...pending]) cancel();
      handles.clear();
    },
    { once: true },
  );
})();
