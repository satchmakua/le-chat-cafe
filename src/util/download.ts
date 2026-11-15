/** Save text as a file through a temporary object URL. Browser-only: returns false
 *  (and does nothing) anywhere without a DOM, such as the test runner. */
export function downloadText(filename: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
