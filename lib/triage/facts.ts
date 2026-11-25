/**
 * The questions people ask most that no page answers, with the reply the
 * account owner approved for each (2026-11-25).
 *
 * Why this exists: a model answering from its own memory about plans, prices
 * and versions gets them wrong, and a wrong answer goes out under the owner's
 * name. So these few facts are written down once, checked, and handed to the
 * model as the only thing it may say on the subject.
 *
 * Where each fact comes from (checked 2026-11-25):
 *   - Claude Code needs a paid plan: code.claude.com/docs/en/setup
 *     ("The free claude.ai plan does not include Claude Code access") and the
 *     plan table on claude.com/pricing.
 *   - Pro is US$20 a month billed monthly: claude.com/pricing.
 *   - Claude Code runs on macOS, Windows and Linux: code.claude.com/docs/en/setup.
 *   - Codex is included in ChatGPT Free ("quick coding tasks"):
 *     developers.openai.com/codex/pricing.
 *   - Hong Kong, Macau and mainland China are not supported regions:
 *     anthropic.com/supported-countries.
 *
 * "Is the free plan enough?" is always answered with "no, it needs a paid
 * plan": the owner's decision, because nearly everything he teaches needs one.
 *
 * Prices and plans change. When they do, this is the one place to edit.
 */

/** Addresses the answers below hand out; allowed in a reply like a page's own links. */
export const FAQ_LINKS = ["code.claude.com/docs/en/setup"];

export const FAQ_TEXT = `【常見問題】這幾題創作者已經定好回答。對方問的就是其中一題的時候，照那一句回：可以順著對方的問法微調用字，意思不能變，也不要多加別的資訊。對方沒問到的，不要主動加在別的回答後面。

1. 問 Claude 免費版能不能用（「免費版可以嗎」「這個功能免費版也支援嗎」「一定要付費嗎」）
   先看【頁面內容】裡有沒有出現「Claude Code」這幾個字：
   - 有 →「免費版沒辦法哦，這個要用到 Claude Code，要 Pro 以上才有～」
   - 沒有 →「免費版沒辦法哦，要 Pro 以上才有～」
   例外：對方問的是別的工具（不是 Claude）的免費版，或頁面自己寫明那個工具免費，就照頁面回答；頁面沒寫就分到 "other"。
2. 問 Pro 夠不夠用、要買哪個方案
   →「Pro 就很夠用了哦，一個月 20 美金，真的常常用到上限再升級就好～」
3. 問 Windows 或 Mac 能不能用、是不是一定要電腦
   →「可以哦，Windows 跟 Mac 都能用，只是要用電腦，手機目前沒辦法～」
   只問手機或平板能不能做，用 "device" 那一類，不用這句。
4. 問 Claude Code 是什麼、去哪裡下載或安裝
   →「Claude Code 就是裝在電腦上、直接幫你動手做事的 Claude，照官方這頁裝就可以了哦～ code.claude.com/docs/en/setup」
5. 問 ChatGPT 免費版能不能用 Codex
   →「免費版也有 Codex 哦，只是額度很少，大概只夠試試看～」
6. 問不會寫程式能不能做
   →「不會寫程式也可以哦，照著頁面一步一步複製貼上就好～」

下面這些只有創作者本人能回，一律分到 "other"：
- 想合作、業配、問報價。
- 問他的課程、教學服務、怎麼跟他學、怎麼收費。
- 問香港、澳門、中國大陸能不能用 Claude，或說那邊打不開頁面。Claude 官方沒有開放這些地區；不要教對方翻牆或換地區。`;
