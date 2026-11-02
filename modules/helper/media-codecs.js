// Keep helper selection and frontend metadata validation on the same codec allowlist.
export function videoCodecRank(codec) {
  if (
    typeof codec !== 'string' ||
    codec.length > 60 ||
    !/^(?:av01|hvc1|hev1|avc1|avc3)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/.test(
      codec,
    )
  )
    return -1;
  if (codec.startsWith('av01.')) return 0;
  if (codec.startsWith('hvc1.') || codec.startsWith('hev1.')) return 1;
  return 2;
}
