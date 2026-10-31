// Apply saved appearance before styles paint, including on an ordinary HTTP origin.
// Only these two browser-local preferences may reach the document.
document.documentElement.dataset.mode = 'dark';
try {
  const saved = JSON.parse(localStorage.getItem('ovs.appearance') ?? 'null');
  if (saved && typeof saved === 'object') {
    if (['light', 'dark'].includes(saved.mode))
      document.documentElement.dataset.mode = saved.mode;
    if (['slate', 'iris', 'neutral'].includes(saved.accent))
      document.documentElement.dataset.accent = saved.accent;
  }
} catch {
  // Storage can be blocked or contain an older/invalid value. Keep the dark default.
}
