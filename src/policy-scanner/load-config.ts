import { readFile } from 'node:fs/promises';

import type { ScannerConfig, ScannerDomainsConfig, ScannerRulesConfig } from './config-schema.ts';

const safeDefaultRules: ScannerRulesConfig = {
  trusted_domains: ['.gov.cn', '.npc.gov.cn', '.org.cn'],
  derivative_keywords: ['解读', '一图读懂', '新闻通稿', '问答', '报道'],
  pdf_elevation: true,
  default_search_engines: ['bing_cn', 'baidu', 'sogou', 'bing'],
  default_search_limit: 10,
  default_fetch_max_chars: 24000,
};

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadRulesConfig(
  rulesPath: URL,
  warn: (message: string) => void,
): Promise<ScannerRulesConfig> {
  try {
    return JSON.parse(await readFile(rulesPath, 'utf8')) as ScannerRulesConfig;
  } catch (error) {
    if (isMissingFileError(error)) {
      warn('⚠️ 警告：配置文件缺失，正在回退到安全默认规则...');
      return safeDefaultRules;
    }

    if (error instanceof SyntaxError) {
      warn('⚠️ 警告：配置文件格式错误，正在回退到安全默认规则...');
      return safeDefaultRules;
    }

    throw error;
  }
}

export async function loadScannerConfig(input: {
  rulesPath: URL;
  domainsPath: URL;
  warn?: (message: string) => void;
}): Promise<ScannerConfig> {
  const warn = input.warn ?? console.warn;
  const rules = await loadRulesConfig(input.rulesPath, warn);
  const domains = JSON.parse(await readFile(input.domainsPath, 'utf8')) as ScannerDomainsConfig;
  return { rules, domains };
}
