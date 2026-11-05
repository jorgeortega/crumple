import { parse } from 'yaml';
import { failure, type Io } from './io.js';

// The OpenAPI document: a file, or a URL, since many APIs serve their own /openapi.json.
// JSON or YAML, because yaml reads both.

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 10 * 1024 * 1024;

const isUrl = (source: string): boolean => /^https?:\/\//i.test(source);

async function readSource(source: string, io: Io): Promise<string> {
  if (!isUrl(source)) {
    try {
      return await io.readFile(source);
    } catch {
      throw failure(`Couldn't read ${source}. Check the path, and that it's your OpenAPI document.`);
    }
  }

  let response: Response;
  try {
    response = await io.fetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw failure(`Couldn't fetch ${source}. Check the address, or save the document and pass the file.`);
  }
  if (!response.ok) throw failure(`Fetching ${source} answered ${response.status}. Check the address, or save the document and pass the file.`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw failure(`${source} is over 10 MB, which is too big for an OpenAPI document. Save a smaller one and pass the file.`);
  return text;
}

export async function loadDocument(source: string, io: Io): Promise<unknown> {
  const text = await readSource(source, io);
  try {
    return parse(text);
  } catch (error) {
    throw failure(`Couldn't read ${source}: ${(error as Error).message.split('\n')[0] ?? 'it isn\'t JSON or YAML'}. Check that it's valid JSON or YAML.`);
  }
}
