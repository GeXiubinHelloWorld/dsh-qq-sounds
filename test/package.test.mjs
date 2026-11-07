// 包元数据的编码守卫：中文被写坏过一次（PowerShell 按 GBK 读 UTF-8 再回写），
// 表现是插件页卡片上的描述变成「鏊?QQ 鐂勫…」。这里把它变成 CI 能拦住的断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

/** UTF-8 被当成 GBK 解码后常见的乱码字符。 */
const MOJIBAKE = /[鐂鏊勫閿鎻锛銆鈥锟]/;

async function readText(name) {
  const bytes = await readFile(fileURLToPath(new URL(name, ROOT)));
  return { bytes, text: bytes.toString("utf8") };
}

test("package.json 不能带 BOM，且中文描述不能是乱码", async () => {
  const { bytes, text } = await readText("package.json");
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "package.json 不应带 UTF-8 BOM");

  const pkg = JSON.parse(text);
  assert.equal(typeof pkg.description, "string");
  assert.ok(pkg.description.length > 0, "description 不能为空");
  assert.doesNotMatch(pkg.description, MOJIBAKE, "description 出现了 UTF-8→GBK 乱码");
  assert.match(pkg.description, /[\u4e00-\u9fa5]/, "description 应保留中文");

  // 插件页卡片显示的就是这两个字段，顺便校验清单没被写坏。
  assert.equal(pkg.name, "dsh-qq-sounds");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
});

test("README / cordis.patch.yml / 客户端与宿主源码不含乱码", async () => {
  for (const file of ["README.md", "README.en.md", "cordis.patch.yml", "lib/host.js", "lib/client.js"]) {
    const { text } = await readText(file);
    assert.doesNotMatch(text, MOJIBAKE, `${file} 出现了 UTF-8→GBK 乱码`);
  }
});
