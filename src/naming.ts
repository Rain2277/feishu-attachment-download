/**
 * 命名规则引擎
 *
 * 支持在模板中使用以下变量（占位符），变量用花括号包裹：
 *  - {原文件名}   原始文件名（含扩展名，如 report.pdf）
 *  - {文件名}     原始文件名（不含扩展名，如 report）
 *  - {扩展名}     原始文件扩展名（不含点，如 pdf）
 *  - {序号}       全局序号，从 1 开始，可用 {序号:3} 指定补零位数（默认 4 位）
 *  - {日期}       打包当天日期，格式 YYYY-MM-DD
 *  - {字段名}     表格中任意字段的值（文本字段取文本，多值字段以顿号连接）
 *
 * 示例模板：
 *  - {姓名}_{日期}_{序号}            ->  张三_2026-09-24_0001
 *  - {部门}-{原文件名}                ->  研发部-report.pdf
 *  - {项目编号}_{文件名}.{扩展名}     ->  PRJ-001_report.pdf
 */

// 从原始文件名拆出：不含扩展名的部分、扩展名（含点）
export function splitFileName(fullName: string): { base: string; ext: string } {
  const lastDot = fullName.lastIndexOf('.');
  // 无扩展名或扩展名为空
  if (lastDot <= 0 || lastDot === fullName.length - 1) {
    return { base: fullName, ext: '' };
  }
  return {
    base: fullName.slice(0, lastDot),
    ext: fullName.slice(lastDot + 1),
  };
}

// 去掉文件名中 Windows / 常见文件系统不允许的字符
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// 单次命名所需的上下文
export interface NamingContext {
  /** 当前记录的字段值：字段名 -> 展示字符串 */
  fieldValues: Record<string, string>;
  /** 原始文件名（含扩展名） */
  originalName: string;
  /** 全局序号，从 1 开始 */
  index: number;
  /** 打包日期 YYYY-MM-DD */
  date: string;
}

const MAX_TEMPLATE_LENGTH = 200;

/**
 * 根据模板生成目标文件名（不含扩展名部分）。
 * 未识别/已移除的变量会被替换为空串；全部为空时回退为“未命名”。
 */
export function buildBaseName(template: string, ctx: NamingContext): string {
  const { base, ext } = splitFileName(ctx.originalName);
  const trimmed = template.trim();
  if (!trimmed) return sanitizeFilename(base);

  let out = trimmed;
  const tokenRegex = /\{([^{}]+)\}/g;

  out = out.replace(tokenRegex, (_raw, keyRaw) => {
    const key = keyRaw.trim();
    if (!key) return '';

    // 序号变量：{序号} / {序号:3}
    const seqMatch = key.match(/^序号(?::(\d+))?$/);
    if (seqMatch) {
      const pad = seqMatch[1] ? parseInt(seqMatch[1], 10) : 4;
      const digits = Math.max(1, Math.min(9, pad));
      return String(ctx.index).padStart(digits, '0');
    }

    switch (key) {
      case '原文件名':
        return ctx.originalName;
      case '文件名':
        return base;
      case '扩展名':
        return ext;
      case '日期':
        return ctx.date;
      default:
        // 尝试按字段名取值
        if (ctx.fieldValues[key] !== undefined) {
          return ctx.fieldValues[key] ?? '';
        }
        return '';
    }
  });

  // 清理模板残留的空占位、多余分隔符
  out = out.replace(/[{}]/g, '');
  out = out.replace(/_+$/g, '').replace(/-+$/g, '').replace(/\.+$/g, '');
  out = out.replace(/[_\- ]{2,}/g, ' ');
  const cleaned = sanitizeFilename(out);
  return cleaned || '未命名';
}

/**
 * 在 ZIP 中保证文件名唯一。
 * 若目标 base 名已被占用，则追加 _2、_3 … 后缀。
 */
export function makeUniqueName(
  base: string,
  ext: string,
  used: Set<string>
): { name: string; added: boolean } {
  const targetExt = ext ? `.${ext}` : '';
  let candidate = `${base}${targetExt}`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return { name: candidate, added: true };
  }
  let i = 2;
  while (used.has(`${base}_${i}${targetExt}`)) {
    i++;
  }
  candidate = `${base}_${i}${targetExt}`;
  used.add(candidate);
  return { name: candidate, added: false };
}

/** 校验模板长度，避免用户输入过长导致文件名异常 */
export function isTemplateTooLong(template: string): boolean {
  return template.length > MAX_TEMPLATE_LENGTH;
}
