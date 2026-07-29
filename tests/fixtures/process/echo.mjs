#!/usr/bin/env node
/**
 * Windows shebang 与参数数组测试夹具。
 *
 * 该脚本只把首个参数写入 stdout，帮助验证 Execa 执行脚本入口时不会
 * 经过 Shell 插值，也不会吞掉标准输出。
 */

process.stdout.write(`${process.argv[2] ?? ''}\n`);
