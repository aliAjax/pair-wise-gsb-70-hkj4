/**
 * 极简 YAML 子集解析器。
 *
 * 支持本平台契约定义用到的语法：块级映射、块级序列、流式映射 `{ a: b }`、
 * 流式序列 `[a, b]`、单双引号标量、数字/布尔/null 与行内注释。
 * 不支持锚点、多行字符串和文档标记以外的指令。
 */

export class MiniYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiniYamlError';
  }
}

interface YamlLine {
  indent: number;
  text: string;
  lineNo: number;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || line[index - 1] === ' ' || line[index - 1] === '\t')) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** 找到引号与流式括号之外的第一层冒号，用于拆分键值。 */
function findTopColon(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === ':' && depth === 0) return index;
  }
  return -1;
}

function scalarize(token: string, lineNo: number): unknown {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) {
      throw new MiniYamlError(`第 ${lineNo} 行单引号字符串未闭合`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw new MiniYamlError(`第 ${lineNo} 行双引号字符串未闭合`);
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === 'null' || trimmed === '~' || trimmed === 'Null' || trimmed === 'NULL') return null;
  if (trimmed === 'true' || trimmed === 'True') return true;
  if (trimmed === 'false' || trimmed === 'False') return false;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseFlow(text: string, lineNo: number): unknown {
  let pos = 0;

  function fail(reason: string): never {
    throw new MiniYamlError(`第 ${lineNo} 行${reason}`);
  }

  function skipWs(): void {
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
  }

  function parseValue(): unknown {
    skipWs();
    const char = text[pos];
    if (char === '{') return parseFlowMap();
    if (char === '[') return parseFlowSeq();
    if (char === "'" || char === '"') {
      const quote = char;
      let end = pos + 1;
      while (end < text.length) {
        if (quote === '"' && text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === quote) break;
        end += 1;
      }
      if (end >= text.length) fail('引号未闭合');
      const token = text.slice(pos, end + 1);
      pos = end + 1;
      return scalarize(token, lineNo);
    }
    let end = pos;
    while (end < text.length && text[end] !== ',' && text[end] !== '}' && text[end] !== ']') {
      end += 1;
    }
    const token = text.slice(pos, end);
    pos = end;
    return scalarize(token, lineNo);
  }

  function parseKey(): string {
    skipWs();
    if (text[pos] === "'" || text[pos] === '"') {
      const value = parseValue();
      return value === null ? '' : String(value);
    }
    let end = pos;
    while (end < text.length && text[end] !== ':' && text[end] !== ',' && text[end] !== '}') {
      end += 1;
    }
    const token = text.slice(pos, end);
    pos = end;
    const key = scalarize(token, lineNo);
    return key === null ? '' : String(key);
  }

  function parseFlowMap(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    pos += 1;
    skipWs();
    if (text[pos] === '}') {
      pos += 1;
      return out;
    }
    for (;;) {
      const key = parseKey();
      skipWs();
      if (text[pos] !== ':') fail('流式映射缺少冒号');
      pos += 1;
      out[key] = parseValue();
      skipWs();
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      if (text[pos] === '}') {
        pos += 1;
        return out;
      }
      fail('流式映射缺少逗号或右括号');
    }
  }

  function parseFlowSeq(): unknown[] {
    const out: unknown[] = [];
    pos += 1;
    skipWs();
    if (text[pos] === ']') {
      pos += 1;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      skipWs();
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      if (text[pos] === ']') {
        pos += 1;
        return out;
      }
      fail('流式序列缺少逗号或右括号');
    }
  }

  const value = parseValue();
  skipWs();
  if (pos < text.length) fail('流式结构之后存在多余内容');
  return value;
}

function scalarOrFlow(text: string, lineNo: number): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseFlow(trimmed, lineNo);
  return scalarize(trimmed, lineNo);
}

function looksLikeMapEntry(text: string): boolean {
  const colon = findTopColon(text);
  return colon >= 0 && (colon === text.length - 1 || text[colon + 1] === ' ');
}

export function parseMiniYaml(source: string): unknown {
  const lines: YamlLine[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const trimmedRaw = raw.trim();
    if (trimmedRaw === '---' || trimmedRaw === '...') return;
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (!stripped.trim()) return;
    if (/^\t/.test(stripped)) {
      throw new MiniYamlError(`第 ${index + 1} 行使用了制表符缩进`);
    }
    lines.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      lineNo: index + 1,
    });
  });
  if (!lines.length) return null;

  const state = { i: 0 };

  function parseBlock(indent: number): unknown {
    const first = lines[state.i];
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(indent);
    return parseMap(indent);
  }

  function parseSeq(indent: number): unknown[] {
    const out: unknown[] = [];
    while (state.i < lines.length) {
      const line = lines[state.i];
      if (line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) break;
      const rest = line.text.replace(/^-\s*/, '');
      if (!rest) {
        state.i += 1;
        if (state.i < lines.length && lines[state.i].indent > indent) {
          out.push(parseBlock(lines[state.i].indent));
        } else {
          out.push(null);
        }
        continue;
      }
      if (looksLikeMapEntry(rest)) {
        const virtualIndent = indent + (line.text.length - rest.length);
        lines[state.i] = { indent: virtualIndent, text: rest, lineNo: line.lineNo };
        out.push(parseMap(virtualIndent));
      } else {
        out.push(scalarOrFlow(rest, line.lineNo));
        state.i += 1;
      }
    }
    return out;
  }

  function parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (state.i < lines.length) {
      const line = lines[state.i];
      if (line.indent !== indent || line.text === '-' || line.text.startsWith('- ')) break;
      const colon = findTopColon(line.text);
      if (colon < 0) {
        throw new MiniYamlError(`第 ${line.lineNo} 行缺少键值冒号`);
      }
      const key = String(scalarize(line.text.slice(0, colon), line.lineNo) ?? '');
      const rest = line.text.slice(colon + 1).trim();
      state.i += 1;
      if (rest) {
        out[key] = scalarOrFlow(rest, line.lineNo);
      } else if (state.i < lines.length && lines[state.i].indent > indent) {
        out[key] = parseBlock(lines[state.i].indent);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  const value = parseBlock(lines[0].indent);
  if (state.i < lines.length) {
    throw new MiniYamlError(`第 ${lines[state.i].lineNo} 行缩进无法与上文对齐`);
  }
  return value;
}
