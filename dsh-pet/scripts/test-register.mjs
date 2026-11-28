/**
 * 测试入口预载：把 test-ts-resolver 注册成模块解析钩子。
 * 测试里的真实插件实例也要与正在运行的 Windows 内存管理隔离。
 * 由 package.json 的 test 脚本以 --import 引入，仅对测试进程生效。
 * @module dsh-pet/scripts/test-register
 */
import { register } from 'node:module';

register('./test-ts-resolver.mjs', import.meta.url);

const { setSystemMemoryRuntime } = await import('../src/host/system-memory.ts');
setSystemMemoryRuntime({ platform: 'linux', fetch: async () => new Response(null, { status: 503 }) });
