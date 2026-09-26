/** The message a failed API response carries: its JSON `error` when it has one, else its text. */
export async function responseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // not JSON
  }
  return text || fallback;
}
