export async function parseApiResponse<T>(response: Response): Promise<T> {
  const bodyText = await response.text()
  const contentType = response.headers.get('content-type') || 'unknown content type'
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`

  if (!bodyText.trim()) {
    throw new Error(response.ok
      ? `The API returned an empty response (${status}); expected JSON.`
      : `The API request failed (${status}) with an empty response. Check that the API server is running.`)
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    const responseKind = contentType.includes('json') ? 'invalid JSON' : `non-JSON content (${contentType})`
    throw new Error(`The API returned ${responseKind} (${status}). Check that the API server is running and the request reached the API.`)
  }

  if (!response.ok) {
    const apiError = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `The API request failed (${status}).`
    throw new Error(apiError)
  }

  return body as T
}
