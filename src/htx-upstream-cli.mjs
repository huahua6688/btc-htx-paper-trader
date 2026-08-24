import {
  buildHtxCapabilityReport,
  checkHtxUpstream,
  getHtxInstalledStatus,
  updateHtxCli
} from "./htx-upstream.mjs";

const command = process.argv[2] ?? "status";
const json = process.argv.includes("--json");
const verify = process.argv.includes("--verify");

function short(value) { return value ? String(value).slice(0, 16) : "—"; }

function formatStatus(status) {
  const metadata = status.installedMetadata;
  const compatibility = metadata?.compatibility ?? null;
  return [
    "HTX 官方 CLI 状态（只读）",
    `来源：${status.sourceRepo}`,
    `路径：${status.cliPath}`,
    `资产：${status.asset}`,
    `已安装：${status.installed ? "是" : "否"}`,
    `Release：${metadata?.release?.tag ?? status.sourceManifest?.release?.tag ?? "未知"}`,
    `SHA-256：${status.installedSha256 ?? "—"}`,
    `Binary SHA 验证：${status.hashVerified ? status.identityMatchesMetadata ? "PASS" : "FAIL/缺少运行时元数据" : "未执行（显示 installed metadata）"}`,
    `上次兼容检查：${compatibility ? `${compatibility.compatible ? "PASS" : "FAIL"} / ${compatibility.checkedAt}` : "尚未运行"}`,
    `上游更新：${status.upstreamUpdateAvailable === null ? "尚未执行 htx:check" : status.upstreamUpdateAvailable ? "有" : "无"}`,
    "安全：状态命令不调用交易接口，不修改 binary。"
  ].join("\n");
}

function formatCheck(result) {
  const digest = result.selectedAsset.digest ?? "官方未提供";
  const update = result.updateAvailable === null ? "无法确定（本地 release/asset 身份不足）" : result.updateAvailable ? "是" : "否";
  return [
    "HTX 官方 CLI 上游检查（未修改生产文件）",
    `Installed：${result.installed.release ?? "未安装/身份未知"} / ${short(result.installed.sha256)}…`,
    `Upstream：${result.upstream.tag} / release #${result.upstream.id} / commit ${short(result.upstream.commitSha)}…`,
    `Asset：${result.selectedAsset.name} / ${result.selectedAsset.size} bytes`,
    `官方 Release digest：${digest}`,
    `officialChecksumProvided：${result.officialChecksumProvided}`,
    `官方 checksum 已验证：${result.officialChecksumVerified ? "是" : "否"}`,
    `比较依据：${result.comparison}`,
    `需要更新：${update}`,
    "htx:check 只读 GitHub Release API，不下载、不替换 binary。"
  ].join("\n");
}

function formatUpdate(result) {
  const metadata = result.metadata;
  const capability = metadata.capabilityReport ?? buildHtxCapabilityReport(result.compatibility);
  return [
    `HTX CLI 更新：${result.changed ? "已原子安装" : "版本未变，重新验证完成"}`,
    `Release：${metadata.release.tag} / commit ${metadata.release.commitSha ?? "未取得"}`,
    `Asset：${metadata.asset.name}`,
    `SHA-256：${metadata.installedSha256}`,
    `官方 checksum：${metadata.asset.officialChecksumProvided ? metadata.asset.officialChecksumVerified ? "已验证" : "失败" : "未提供；仅记录本地 SHA-256"}`,
    `Compatibility：${result.compatibility.compatible ? "PASS" : "FAIL"}（${result.compatibility.commands.length} commands）`,
    `Rollback：${result.backupPath ?? "首次安装，无旧 binary"}`,
    `Capability：当前采用 ${capability.currentSupported.length} 个采集任务；上游未采用 ${capability.upstreamPublicNotAdopted.length} 类；不兼容 ${capability.incompatible.length} 项`,
    "安全白名单未自动扩大；仍只允许现有 BTC-USDT public commands。"
  ].join("\n");
}

async function main() {
  let result;
  let formatted;
  if (command === "status") {
    result = await getHtxInstalledStatus({ verifyHash: verify });
    formatted = formatStatus(result);
  } else if (command === "check") {
    result = await checkHtxUpstream();
    formatted = formatCheck(result);
  } else if (command === "update") {
    result = await updateHtxCli();
    formatted = formatUpdate(result);
  } else {
    throw new Error("Usage: npm run htx:status [-- --verify] | htx:check | htx:update");
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatted}\n`);
}

await main();
