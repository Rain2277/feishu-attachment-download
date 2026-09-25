// 命名引擎单元验证：不依赖飞书环境，直接运行
import {
  buildBaseName,
  sanitizeFilename,
  splitFileName,
  makeUniqueName,
  NamingContext,
} from './src/naming.ts';

function check(desc: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}\n      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`);
  if (!ok) process.exitCode = 1;
}

const baseCtx = (over: Partial<NamingContext> = {}): NamingContext => ({
  fieldValues: { 姓名: '张三', 部门: '研发部', 项目编号: 'PRJ-001' },
  originalName: 'report.pdf',
  index: 1,
  date: '2026-09-24',
  ...over,
});

check('默认模板取原文件名', buildBaseName('{原文件名}', baseCtx()), 'report.pdf');
check('字段+序号+日期', buildBaseName('{姓名}_{日期}_{序号}', baseCtx()), '张三_2026-09-24_0001');
check('自定义序号位数', buildBaseName('{序号:3}', baseCtx()), '001');
check('字段变量', buildBaseName('{部门}-{项目编号}', baseCtx()), '研发部-PRJ-001');
check('文件名(无扩展)+扩展名', buildBaseName('{文件名}.{扩展名}', baseCtx()), 'report.pdf');
check('空模板回退原文件名', buildBaseName('   ', baseCtx()), 'report');
check('不存在的变量清空并去尾分隔符', buildBaseName('{姓名}_{不存在}_', baseCtx()), '张三');
check('非法字符被清洗', sanitizeFilename('a/b:c*?"<>|'), 'a_b_c______');
check('拆分扩展名', splitFileName('a.b.c').ext, 'c');

// 去重
const used = new Set<string>();
console.log('去重：', makeUniqueName('张三_2026-09-24_0001', 'pdf', used).name);
console.log('去重：', makeUniqueName('张三_2026-09-24_0001', 'pdf', used).name);

console.log('\n验证完成');
