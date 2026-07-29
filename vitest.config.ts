import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    /**
     * Windows 上 git 子进程创建开销大，全量并行跑时集成测试（真实临时
     * 仓库，十余次 git 调用）可能超过 5s 默认值，给足余量避免性能型 flake。
     */
    testTimeout: 15_000,
    /**
     * beforeEach 同样要建真实临时仓库（git init/config/add/commit 等十余次
     * 子进程调用），默认 10s hookTimeout 在全量并发负载下与上面的
     * testTimeout 一样会制造假失败（tests/integration/git/checkpoint.test.ts）。
     */
    hookTimeout: 30_000,
  },
});
