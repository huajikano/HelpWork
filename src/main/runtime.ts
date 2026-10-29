// 运行时状态：当前数据目录与初始化错误（单例，供各模块读取）
let currentDataDir = '';
let initError: string | null = null;

export function setDataDir(d: string): void {
  currentDataDir = d;
}

/** 获取当前数据目录；未初始化时抛错（由调用方转中文提示） */
export function getDataDir(): string {
  if (!currentDataDir) throw new Error('数据目录尚未初始化');
  return currentDataDir;
}

/** 获取当前数据目录；允许未初始化（返回空串） */
export function tryGetDataDir(): string {
  return currentDataDir;
}

export function setInitError(msg: string | null): void {
  initError = msg;
}

export function getInitError(): string | null {
  return initError;
}
