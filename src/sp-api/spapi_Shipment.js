/**
 * FbaShipment.gs
 * FBA納品プラン作成のメイン処理
 *
 * 使用するScript Properties:
 * - LWA_CLIENT_ID: LWAクライアントID
 * - LWA_CLIENT_SECRET: LWAクライアントシークレット
 * - LWA_REFRESH_TOKEN: LWAリフレッシュトークン
 * - SELLER_ID: セラーID
 * - MARKETPLACE_ID: マーケットプレイスID（日本: A1VC38T7YXB528）
 * - SP_API_ENDPOINT: SP-APIエンドポイント（例: https://sellingpartnerapi-fe.amazon.com）
 * - LWA_TOKEN_ENDPOINT: LWAトークンエンドポイント（https://api.amazon.com/auth/o2/token）
 * - SHIP_FROM_NAME: 発送者名
 * - SHIP_FROM_ADDRESS_LINE1: 住所1
 * - SHIP_FROM_ADDRESS_LINE2: 住所2（任意）
 * - SHIP_FROM_CITY: 市区町村
 * - SHIP_FROM_STATE: 都道府県
 * - SHIP_FROM_POSTAL_CODE: 郵便番号
 * - SHIP_FROM_COUNTRY_CODE: 国コード（JP）
 * - SHIP_FROM_PHONE: 電話番号
 */

var SPAPI_SHIPMENT_CACHE_KEY = "SPAPI_SHIPMENT_SKU_COUNTS";
var SPAPI_LABEL_SPLIT_CACHE_KEY = "SPAPI_SHIPMENT_LABEL_SPLIT";
var SPAPI_LABEL_SCANNABLE_TYPES = ["EAN", "JAN", "UPC", "ISBN", "GCID", "GTIN"];
var SPAPI_IDENTIFIER_CACHE_KEY_PREFIX = "spapi:catalog:ident:v1:";
var SPAPI_IDENTIFIER_CACHE_TTL_SECONDS = 600;
var SPAPI_CATALOG_BATCH_SIZE = 2;
var SPAPI_CATALOG_BATCH_INTERVAL_MS = 600;

// ===========================================
// メイン処理
// ===========================================

/**
 * メイン処理: FBA納品プランを作成する
 * メニューから呼び出されるエントリーポイント
 */
function spapi_createShipmentPlan() {
  try {
    const skuCounts = spapi_getSelectedSkus_();

    if (Object.keys(skuCounts).length === 0) {
      Browser.msgBox("エラー", "選択された行にSKUが見つかりません。\\nY列にSKUが入力されているか確認してください。", Browser.Buttons.OK);
      return;
    }

    CacheService.getUserCache().put(SPAPI_SHIPMENT_CACHE_KEY, JSON.stringify(skuCounts), 600);
    CacheService.getUserCache().remove(SPAPI_LABEL_SPLIT_CACHE_KEY);

    const html = HtmlService.createHtmlOutputFromFile("sp-api/spapi_ShipmentDialog")
      .setWidth(520)
      .setHeight(620);
    SpreadsheetApp.getUi().showModalDialog(html, "FBA納品プラン作成");

  } catch (error) {
    console.error("FBA納品プラン作成エラー:", error.message);
    Browser.msgBox("エラー", "処理中にエラーが発生しました:\\n" + error.message, Browser.Buttons.OK);
  }
}

// ===========================================
// SKU取得処理
// ===========================================

/**
 * 選択範囲の各行からY列（25列目）のSKUを取得し、集計する
 * @returns {Object} SKUをキー、個数を値とするオブジェクト
 */
function spapi_getSelectedSkus_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const rangeList = sheet.getActiveRangeList();

  if (!rangeList) {
    console.log("選択範囲がありません");
    return {};
  }

  const ranges = rangeList.getRanges();
  const SKU_COLUMN = 25;

  const selectedRows = new Set();
  for (const range of ranges) {
    const rangeStartRow = range.getRow();
    const rangeNumRows = range.getNumRows();
    for (let i = 0; i < rangeNumRows; i++) {
      const rowNum = rangeStartRow + i;
      if (!sheet.isRowHiddenByFilter(rowNum)) {
        selectedRows.add(rowNum);
      }
    }
  }

  if (selectedRows.size === 0) {
    return {};
  }

  const rowArray = Array.from(selectedRows);
  const minRow = Math.min(...rowArray);
  const maxRow = Math.max(...rowArray);
  const skuValues = sheet.getRange(minRow, SKU_COLUMN, maxRow - minRow + 1, 1).getValues();

  const skuCounts = {};
  for (const rowNum of rowArray) {
    const sku = skuValues[rowNum - minRow][0];
    if (sku && String(sku).trim() !== "") {
      const skuStr = String(sku).trim();
      skuCounts[skuStr] = (skuCounts[skuStr] || 0) + 1;
    }
  }

  console.log("SKU集計完了:", JSON.stringify(skuCounts));
  return skuCounts;
}

// ===========================================
// ダイアログ連携処理
// ===========================================

/**
 * ダイアログからSKUデータを取得する
 * @returns {Object} SKUと個数のマップ
 */
function spapi_getCachedSkuCounts() {
  const cached = CacheService.getUserCache().get(SPAPI_SHIPMENT_CACHE_KEY);
  if (!cached) {
    throw new Error("SKUデータが見つかりません。ダイアログを閉じて再実行してください。");
  }
  return JSON.parse(cached);
}

/**
 * ダイアログから呼ばれる納品プラン作成処理
 * @param {string} labelOwner - "AMAZON" または "SELLER"
 * @returns {Object} 処理結果
 *   - success: 作成成功
 *   - labelSplit: 一部SKUがAMAZON貼付不可、ユーザー確認が必要
 *   - labelError: API側でlabelOwnerエラー（フォールバック）
 */
function spapi_submitShipmentPlan(labelOwner) {
  if (labelOwner !== "AMAZON" && labelOwner !== "SELLER") {
    throw new Error("不正なlabelOwnerが指定されました: " + labelOwner);
  }

  const cached = CacheService.getUserCache().get(SPAPI_SHIPMENT_CACHE_KEY);
  if (!cached) {
    throw new Error("SKUデータが見つかりません。ダイアログを閉じて再実行してください。");
  }
  const skuCounts = JSON.parse(cached);

  if (labelOwner === "SELLER") {
    const labelOwnerMap = {};
    for (const sku of Object.keys(skuCounts)) {
      labelOwnerMap[sku] = "SELLER";
    }
    return spapi_executeInboundPlan_(skuCounts, labelOwnerMap);
  }

  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("SP_API_ENDPOINT") || "https://sellingpartnerapi-fe.amazon.com";
  const marketplaceId = props.getProperty("MARKETPLACE_ID");

  if (!marketplaceId) {
    throw new Error("MARKETPLACE_IDがScript Propertiesに設定されていません。");
  }

  const accessToken = spapi_getAccessToken_();
  const classification = spapi_classifySkusByLabelEligibility_(skuCounts, accessToken, marketplaceId, endpoint);

  if (classification.sellerOnlySkus.length === 0 && classification.unknownSkus.length === 0) {
    return spapi_executeInboundPlan_(skuCounts, classification.labelOwnerMap);
  }

  CacheService.getUserCache().put(
    SPAPI_LABEL_SPLIT_CACHE_KEY,
    JSON.stringify(classification.labelOwnerMap),
    600
  );

  const amazonSkus = Object.keys(classification.labelOwnerMap).filter(s => classification.labelOwnerMap[s] === "AMAZON");
  return {
    status: "labelSplit",
    amazonSkus: amazonSkus,
    sellerSkus: classification.sellerOnlySkus,
    unknownSkus: classification.unknownSkus,
    skuCounts: skuCounts
  };
}

/**
 * 分割確認後に納品プランを送信する
 * @returns {Object} 処理結果（success または labelError）
 */
function spapi_confirmLabelSplitAndSubmit() {
  const splitCached = CacheService.getUserCache().get(SPAPI_LABEL_SPLIT_CACHE_KEY);
  if (!splitCached) {
    throw new Error("分類データが見つかりません。ダイアログを閉じて再実行してください。");
  }
  const labelOwnerMap = JSON.parse(splitCached);

  const skuCached = CacheService.getUserCache().get(SPAPI_SHIPMENT_CACHE_KEY);
  if (!skuCached) {
    throw new Error("SKUデータが見つかりません。ダイアログを閉じて再実行してください。");
  }
  const skuCounts = JSON.parse(skuCached);

  CacheService.getUserCache().remove(SPAPI_LABEL_SPLIT_CACHE_KEY);

  return spapi_executeInboundPlan_(skuCounts, labelOwnerMap);
}

/**
 * 納品プラン作成の共通実行処理
 * @param {Object} skuCounts - SKUと個数のマップ
 * @param {Object} labelOwnerMap - SKUごとのlabelOwner設定
 * @returns {Object} 処理結果
 */
function spapi_executeInboundPlan_(skuCounts, labelOwnerMap) {
  const apiResult = spapi_createFbaInboundPlan_(skuCounts, labelOwnerMap);

  if (apiResult && apiResult._labelOwnerError) {
    return {
      status: "labelError",
      failedSkus: apiResult._labelOwnerError.failedSkus,
      rawMessages: apiResult._labelOwnerError.rawMessages
    };
  }

  const inboundPlanId = apiResult.inboundPlanId;
  if (!inboundPlanId) {
    throw new Error("納品プランIDが取得できませんでした。\\nレスポンス: " + JSON.stringify(apiResult));
  }

  CacheService.getUserCache().remove(SPAPI_SHIPMENT_CACHE_KEY);

  const sellerCentralUrl = "https://sellercentral.amazon.co.jp/fba/sendtoamazon/confirm_content_step?wf=" + encodeURIComponent(inboundPlanId);

  return {
    status: "success",
    inboundPlanId: inboundPlanId,
    operationId: apiResult.operationId || null,
    sellerCentralUrl: sellerCentralUrl
  };
}

// ===========================================
// SKU分類処理（Amazon貼付可否判定）
// ===========================================

/**
 * SKU文字列からASIN（B + 9英数字）を抽出する
 * @param {string} sku - SKU文字列
 * @returns {string|null} 抽出したASIN、抽出不可ならnull
 */
function spapi_extractAsinFromSku_(sku) {
  const str = String(sku).toUpperCase();
  const tailMatch = str.match(/B[A-Z0-9]{9}$/);
  if (tailMatch) {
    return tailMatch[0];
  }
  const anyMatch = str.match(/\bB[A-Z0-9]{9}\b/);
  if (anyMatch) {
    return anyMatch[0];
  }
  return null;
}

/**
 * ASINからスキャン可能なidentifier一覧を取得する
 * @param {string} accessToken - SP-APIアクセストークン
 * @param {string} asin - 対象ASIN
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {string} endpoint - SP-APIエンドポイント
 * @returns {Array<string>} identifierTypeの配列（例: ["EAN", "JAN"]）
 */
function spapi_getAsinIdentifiers_(accessToken, asin, marketplaceId, endpoint) {
  const url = endpoint +
              "/catalog/2022-04-01/items/" +
              encodeURIComponent(asin) +
              "?marketplaceIds=" + marketplaceId +
              "&includedData=identifiers";

  const options = {
    method: "get",
    headers: {
      "x-amz-access-token": accessToken,
      "Accept": "application/json"
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode !== 200) {
    throw new Error("Catalog API error (ASIN: " + asin + ", HTTP " + responseCode + "): " + responseBody);
  }

  const json = JSON.parse(responseBody);
  const identifierTypes = [];

  if (!json.identifiers || !Array.isArray(json.identifiers)) {
    return identifierTypes;
  }

  for (const marketplaceEntry of json.identifiers) {
    if (marketplaceEntry.marketplaceId !== marketplaceId) {
      continue;
    }
    const innerList = marketplaceEntry.identifiers || [];
    for (const identifier of innerList) {
      if (identifier.identifierType) {
        identifierTypes.push(String(identifier.identifierType).toUpperCase());
      }
    }
  }

  return identifierTypes;
}

/**
 * ASINがAmazonラベル貼付に対応しているか判定する
 * @param {string} accessToken - SP-APIアクセストークン
 * @param {string} asin - 対象ASIN
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {string} endpoint - SP-APIエンドポイント
 * @returns {boolean} JAN/EAN/UPC/ISBN/GCID/GTINのいずれかが存在すればtrue
 */
function spapi_isAsinAmazonLabelEligible_(accessToken, asin, marketplaceId, endpoint) {
  if (!asin) {
    return false;
  }
  try {
    const identifiers = spapi_getAsinIdentifiers_(accessToken, asin, marketplaceId, endpoint);
    return identifiers.some(type => SPAPI_LABEL_SCANNABLE_TYPES.indexOf(type) !== -1);
  } catch (e) {
    console.warn("Identifier取得失敗 (ASIN: " + asin + "): " + e.message);
    return false;
  }
}

/**
 * Catalog APIレスポンスボディからidentifierTypeの配列を抽出する
 * @param {string} responseBody - レスポンス本文
 * @param {string} marketplaceId - マーケットプレイスID
 * @returns {Array<string>} identifierTypeの配列
 */
function spapi_parseIdentifierTypes_(responseBody, marketplaceId) {
  const identifierTypes = [];
  let json;
  try {
    json = JSON.parse(responseBody);
  } catch (e) {
    return identifierTypes;
  }
  if (!json.identifiers || !Array.isArray(json.identifiers)) {
    return identifierTypes;
  }
  for (const marketplaceEntry of json.identifiers) {
    if (marketplaceEntry.marketplaceId !== marketplaceId) {
      continue;
    }
    const innerList = marketplaceEntry.identifiers || [];
    for (const identifier of innerList) {
      if (identifier.identifierType) {
        identifierTypes.push(String(identifier.identifierType).toUpperCase());
      }
    }
  }
  return identifierTypes;
}

/**
 * identifierキャッシュキーを生成する
 * @param {string} asin - ASIN
 * @returns {string} キャッシュキー
 */
function spapi_buildIdentifierCacheKey_(asin) {
  return SPAPI_IDENTIFIER_CACHE_KEY_PREFIX + asin;
}

/**
 * ASINに対応するidentifierキャッシュを取得する
 * @param {string} asin - ASIN
 * @returns {Array<string>|null} キャッシュ済みのidentifier配列、未ヒットはnull
 */
function spapi_getCachedIdentifiers_(asin) {
  const raw = CacheService.getScriptCache().get(spapi_buildIdentifierCacheKey_(asin));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * ASINに対応するidentifierをキャッシュに保存する
 * @param {string} asin - ASIN
 * @param {Array<string>} identifiers - identifierTypeの配列
 */
function spapi_putCachedIdentifiers_(asin, identifiers) {
  try {
    CacheService.getScriptCache().put(
      spapi_buildIdentifierCacheKey_(asin),
      JSON.stringify(identifiers),
      SPAPI_IDENTIFIER_CACHE_TTL_SECONDS
    );
  } catch (e) {
    console.warn("identifierキャッシュ保存失敗 (ASIN: " + asin + "): " + e.message);
  }
}

/**
 * 複数ASINのidentifierキャッシュをまとめて取得する
 * @param {Array<string>} asins - ASIN配列
 * @returns {Object} { hit: { asin: identifiers[] }, miss: string[] }
 */
function spapi_getCachedIdentifiersBulk_(asins) {
  const hit = {};
  const miss = [];
  if (!asins || asins.length === 0) {
    return { hit: hit, miss: miss };
  }
  const keys = asins.map(asin => spapi_buildIdentifierCacheKey_(asin));
  const cached = CacheService.getScriptCache().getAll(keys) || {};
  for (const asin of asins) {
    const raw = cached[spapi_buildIdentifierCacheKey_(asin)];
    if (!raw) {
      miss.push(asin);
      continue;
    }
    try {
      hit[asin] = JSON.parse(raw);
    } catch (e) {
      miss.push(asin);
    }
  }
  return { hit: hit, miss: miss };
}

/**
 * Catalog APIをバッチ並列で呼び出し、ASINごとのidentifierTypeを取得する
 * @param {string} accessToken - SP-APIアクセストークン
 * @param {Array<string>} asins - 取得対象のASIN配列（重複除去済み）
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {string} endpoint - SP-APIエンドポイント
 * @returns {Object} { asin: identifierTypes[] }
 */
function spapi_fetchAsinIdentifiersBatch_(accessToken, asins, marketplaceId, endpoint) {
  const results = {};
  if (!asins || asins.length === 0) {
    return results;
  }

  const buildRequest = function(asin) {
    return {
      url: endpoint +
           "/catalog/2022-04-01/items/" +
           encodeURIComponent(asin) +
           "?marketplaceIds=" + marketplaceId +
           "&includedData=identifiers",
      method: "get",
      headers: {
        "x-amz-access-token": accessToken,
        "Accept": "application/json"
      },
      muteHttpExceptions: true
    };
  };

  for (let i = 0; i < asins.length; i += SPAPI_CATALOG_BATCH_SIZE) {
    const batch = asins.slice(i, i + SPAPI_CATALOG_BATCH_SIZE);
    const requests = batch.map(buildRequest);

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      console.warn("Catalog APIバッチ呼び出し失敗: " + e.message);
      for (const asin of batch) {
        results[asin] = [];
      }
      if (i + SPAPI_CATALOG_BATCH_SIZE < asins.length) {
        Utilities.sleep(SPAPI_CATALOG_BATCH_INTERVAL_MS);
      }
      continue;
    }

    let retryIndexes = [];
    for (let idx = 0; idx < responses.length; idx++) {
      if (responses[idx].getResponseCode() === 429) {
        retryIndexes.push(idx);
      }
    }

    let backoff = 1000;
    for (let attempt = 0; attempt < 2 && retryIndexes.length > 0; attempt++) {
      Utilities.sleep(backoff);
      const retryRequests = retryIndexes.map(idx => requests[idx]);
      let retryResponses;
      try {
        retryResponses = UrlFetchApp.fetchAll(retryRequests);
      } catch (e) {
        console.warn("Catalog APIリトライ失敗: " + e.message);
        break;
      }
      const nextRetry = [];
      for (let j = 0; j < retryResponses.length; j++) {
        const originalIdx = retryIndexes[j];
        const response = retryResponses[j];
        if (response.getResponseCode() === 429) {
          nextRetry.push(originalIdx);
        } else {
          responses[originalIdx] = response;
        }
      }
      retryIndexes = nextRetry;
      backoff *= 2;
    }

    for (let idx = 0; idx < responses.length; idx++) {
      const asin = batch[idx];
      const response = responses[idx];
      const code = response.getResponseCode();
      if (code === 200) {
        results[asin] = spapi_parseIdentifierTypes_(response.getContentText(), marketplaceId);
        continue;
      }
      console.warn("Catalog API error (ASIN: " + asin + ", HTTP " + code + "): " + response.getContentText());
      results[asin] = [];
    }

    if (i + SPAPI_CATALOG_BATCH_SIZE < asins.length) {
      Utilities.sleep(SPAPI_CATALOG_BATCH_INTERVAL_MS);
    }
  }

  return results;
}

/**
 * 全SKUをAmazon貼付可否で分類する
 * @param {Object} skuCounts - SKUと個数のマップ
 * @param {string} accessToken - SP-APIアクセストークン
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {string} endpoint - SP-APIエンドポイント
 * @returns {Object} { labelOwnerMap, sellerOnlySkus, unknownSkus }
 */
function spapi_classifySkusByLabelEligibility_(skuCounts, accessToken, marketplaceId, endpoint) {
  const labelOwnerMap = {};
  const sellerOnlySkus = [];
  const unknownSkus = [];
  const skuToAsin = {};

  for (const sku of Object.keys(skuCounts)) {
    const asin = spapi_extractAsinFromSku_(sku);
    if (!asin) {
      labelOwnerMap[sku] = "SELLER";
      unknownSkus.push(sku);
      continue;
    }
    skuToAsin[sku] = asin;
  }

  const uniqueAsins = Array.from(new Set(Object.values(skuToAsin)));
  const cacheResult = spapi_getCachedIdentifiersBulk_(uniqueAsins);
  const asinToIdentifiers = Object.assign({}, cacheResult.hit);

  if (cacheResult.miss.length > 0) {
    const fetched = spapi_fetchAsinIdentifiersBatch_(accessToken, cacheResult.miss, marketplaceId, endpoint);
    for (const asin of Object.keys(fetched)) {
      asinToIdentifiers[asin] = fetched[asin];
      spapi_putCachedIdentifiers_(asin, fetched[asin]);
    }
  }

  for (const sku of Object.keys(skuToAsin)) {
    const asin = skuToAsin[sku];
    const identifiers = asinToIdentifiers[asin] || [];
    const eligible = identifiers.some(type => SPAPI_LABEL_SCANNABLE_TYPES.indexOf(type) !== -1);
    labelOwnerMap[sku] = eligible ? "AMAZON" : "SELLER";
    if (!eligible) {
      sellerOnlySkus.push(sku);
    }
  }

  return {
    labelOwnerMap: labelOwnerMap,
    sellerOnlySkus: sellerOnlySkus,
    unknownSkus: unknownSkus
  };
}

// ===========================================
// SP-API連携処理
// ===========================================

/**
 * SP-APIのアクセストークンを取得する
 * @returns {string} アクセストークン
 */
function spapi_getAccessToken_() {
  return utils_getSpApiAccessToken();
}

/**
 * 出荷元住所をScript Propertiesから取得する
 * @returns {Object} 住所オブジェクト
 */
function spapi_getSourceAddress_() {
  return utils_getSourceAddress();
}

/**
 * SP-API Fulfillment Inbound API 2024-03-20を使用して納品プランを作成する
 * @param {Object} skuCounts - SKUと個数のマップ
 * @param {Object} labelOwnerMap - SKUごとのlabelOwner設定
 * @returns {Object} APIレスポンス または { _labelOwnerError: {...} }
 */
function spapi_createFbaInboundPlan_(skuCounts, labelOwnerMap) {
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("SP_API_ENDPOINT") || "https://sellingpartnerapi-fe.amazon.com";
  const marketplaceId = props.getProperty("MARKETPLACE_ID");

  if (!marketplaceId) {
    throw new Error("MARKETPLACE_IDがScript Propertiesに設定されていません。");
  }

  const accessToken = spapi_getAccessToken_();
  const sourceAddress = spapi_getSourceAddress_();

  const mskus = Object.keys(skuCounts);

  spapi_setPrepDetails_(endpoint, accessToken, marketplaceId, mskus);
  Utilities.sleep(1000);

  const expirationDate = new Date();
  expirationDate.setMonth(expirationDate.getMonth() + 3);
  const expiration = Utilities.formatDate(expirationDate, "Asia/Tokyo", "yyyy-MM-dd");

  const now = new Date();
  const planName = Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMdd_HHmmss") + "_GAS作成";

  const items = spapi_buildItemsArray_(skuCounts, expiration, {}, labelOwnerMap);

  const requestBody = {
    destinationMarketplaces: [marketplaceId],
    items: items,
    sourceAddress: sourceAddress,
    name: planName
  };

  const apiPath = "/inbound/fba/2024-03-20/inboundPlans";
  const url = endpoint + apiPath;

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-amz-access-token": accessToken,
      "Accept": "application/json"
    },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  };

  let response = UrlFetchApp.fetch(url, options);
  let responseCode = response.getResponseCode();
  let responseBody = response.getContentText();

  if (responseCode === 400) {
    const hasAmazon = Object.keys(labelOwnerMap).some(k => labelOwnerMap[k] === "AMAZON");
    if (hasAmazon) {
      const labelError = spapi_detectLabelOwnerError_(responseBody);
      if (labelError) {
        console.warn("labelOwnerエラー検出:", JSON.stringify(labelError));
        return { _labelOwnerError: labelError };
      }
    }

    const retryResult = spapi_handlePrepOwnerError_(responseBody, skuCounts, expiration, endpoint, apiPath, accessToken, marketplaceId, sourceAddress, planName, labelOwnerMap);
    if (retryResult) {
      return retryResult;
    }
  }

  if (responseCode !== 200 && responseCode !== 202) {
    let errorMessage = responseBody;
    try {
      const errorData = JSON.parse(responseBody);
      if (errorData.errors && errorData.errors.length > 0) {
        errorMessage = errorData.errors.map(e => `${e.code}: ${e.message}`).join("\\n");
      }
    } catch (e) {
      // JSONパースに失敗した場合はそのまま使用
    }
    throw new Error("SP-APIエラー (HTTP " + responseCode + "):\\n" + errorMessage);
  }

  return JSON.parse(responseBody);
}

// ===========================================
// 梱包カテゴリー設定処理
// ===========================================

/**
 * setPrepDetails APIを呼び出して、SKUの梱包カテゴリーを設定する
 * @param {string} endpoint - SP-APIエンドポイント
 * @param {string} accessToken - アクセストークン
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {Array} mskus - 設定するSKUの配列
 */
function spapi_setPrepDetails_(endpoint, accessToken, marketplaceId, mskus) {
  const apiPath = "/inbound/fba/2024-03-20/items/prepDetails";
  const url = endpoint + apiPath;

  const mskuPrepDetails = mskus.map(msku => ({
    msku: msku,
    prepCategory: "NONE",
    prepTypes: ["ITEM_NO_PREP"]
  }));

  const requestBody = {
    marketplaceId: marketplaceId,
    mskuPrepDetails: mskuPrepDetails
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-amz-access-token": accessToken,
      "Accept": "application/json"
    },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode !== 200 && responseCode !== 202) {
    console.warn("setPrepDetails APIエラー:", responseBody);
  }
}

/**
 * items配列を構築する
 * @param {Object} skuCounts - SKUと個数のマップ
 * @param {string} expiration - 消費期限（yyyy-MM-dd形式）
 * @param {Object} prepOwnerOverrides - prepOwnerを上書きするSKUのマップ（SKU: "NONE"）
 * @param {Object} labelOwnerMap - SKUごとのlabelOwner設定
 * @returns {Array} items配列
 */
function spapi_buildItemsArray_(skuCounts, expiration, prepOwnerOverrides, labelOwnerMap) {
  const items = [];
  for (const [msku, quantity] of Object.entries(skuCounts)) {
    const prepOwner = prepOwnerOverrides[msku] || "SELLER";
    const labelOwner = labelOwnerMap[msku] === "AMAZON" ? "AMAZON" : "SELLER";
    items.push({
      msku: msku,
      quantity: quantity,
      prepOwner: prepOwner,
      labelOwner: labelOwner,
      expiration: expiration
    });
  }
  return items;
}

/**
 * prepOwnerエラーを解析し、該当SKUをNONEにしてリトライする
 * @param {string} responseBody - エラーレスポンス
 * @param {Object} skuCounts - SKUと個数のマップ
 * @param {string} expiration - 消費期限
 * @param {string} endpoint - APIエンドポイント
 * @param {string} apiPath - APIパス
 * @param {string} accessToken - アクセストークン
 * @param {string} marketplaceId - マーケットプレイスID
 * @param {Object} sourceAddress - 出荷元住所
 * @param {string} planName - 納品プラン名
 * @param {Object} labelOwnerMap - SKUごとのlabelOwner設定
 * @returns {Object|null} 成功時はAPIレスポンス、リトライ不要または失敗時はnull
 */
function spapi_handlePrepOwnerError_(responseBody, skuCounts, expiration, endpoint, apiPath, accessToken, marketplaceId, sourceAddress, planName, labelOwnerMap) {
  try {
    const errorData = JSON.parse(responseBody);
    if (!errorData.errors || errorData.errors.length === 0) {
      return null;
    }

    const prepOwnerOverrides = {};
    let hasPrepOwnerError = false;

    for (const error of errorData.errors) {
      const match = error.message.match(/ERROR:\s*(\S+)\s+does not require prepOwner/);
      if (match) {
        prepOwnerOverrides[match[1]] = "NONE";
        hasPrepOwnerError = true;
      }
    }

    if (!hasPrepOwnerError) {
      return null;
    }

    const items = spapi_buildItemsArray_(skuCounts, expiration, prepOwnerOverrides, labelOwnerMap);

    const requestBody = {
      destinationMarketplaces: [marketplaceId],
      items: items,
      sourceAddress: sourceAddress,
      name: planName
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-amz-access-token": accessToken,
        "Accept": "application/json"
      },
      payload: JSON.stringify(requestBody),
      muteHttpExceptions: true
    };

    const url = endpoint + apiPath;
    const response = UrlFetchApp.fetch(url, options);
    const retryResponseCode = response.getResponseCode();
    const retryResponseBody = response.getContentText();

    if (retryResponseCode === 400) {
      const hasAmazon = Object.keys(labelOwnerMap).some(k => labelOwnerMap[k] === "AMAZON");
      if (hasAmazon) {
        const labelError = spapi_detectLabelOwnerError_(retryResponseBody);
        if (labelError) {
          console.warn("prepOwnerリトライ後にlabelOwnerエラー検出:", JSON.stringify(labelError));
          return { _labelOwnerError: labelError };
        }
      }
    }

    if (retryResponseCode === 200 || retryResponseCode === 202) {
      return JSON.parse(retryResponseBody);
    }

    return null;

  } catch (e) {
    console.error("リトライ処理中にエラー:", e.message);
    return null;
  }
}

/**
 * labelOwnerエラーを検出し、該当SKUと生メッセージを抽出する
 * @param {string} responseBody - エラーレスポンス
 * @returns {Object|null} { failedSkus: Array, rawMessages: Array } または null
 */
function spapi_detectLabelOwnerError_(responseBody) {
  try {
    const errorData = JSON.parse(responseBody);
    if (!errorData.errors || errorData.errors.length === 0) {
      return null;
    }

    const failedSkus = [];
    const rawMessages = [];
    let hasLabelOwnerError = false;

    for (const error of errorData.errors) {
      const msg = error.message || "";
      if (!/label\s?owner|label\s+ownership|cannot\s+be\s+labeled|not\s+eligible\s+for\s+(?:amazon)?\s*label/i.test(msg)) {
        continue;
      }
      hasLabelOwnerError = true;
      rawMessages.push(msg);

      let match = msg.match(/ERROR:\s*(\S+)\s+/);
      if (match) {
        failedSkus.push(match[1]);
        continue;
      }
      match = msg.match(/(?:for\s+(?:SKU|MSKU)|MSKU|SKU)\s+[\"']?([A-Za-z0-9\-_]+)/i);
      if (match) {
        failedSkus.push(match[1]);
        continue;
      }
      match = msg.match(/([A-Za-z0-9][A-Za-z0-9\-_]{3,})\s+(?:does\s+not\s+support|is\s+not\s+eligible|cannot\s+be)/i);
      if (match) {
        failedSkus.push(match[1]);
      }
    }

    if (!hasLabelOwnerError) {
      return null;
    }

    const uniqueSkus = Array.from(new Set(failedSkus));
    return {
      failedSkus: uniqueSkus,
      rawMessages: rawMessages
    };
  } catch (e) {
    console.error("labelOwnerエラー解析失敗:", e.message);
    return null;
  }
}

// ===========================================
// テスト・デバッグ用関数
// ===========================================

/**
 * Script Propertiesの設定状況を確認する（デバッグ用）
 * メニューから直接実行可能
 */
function spapi_checkScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  const keys = [
    "LWA_CLIENT_ID",
    "LWA_CLIENT_SECRET",
    "LWA_REFRESH_TOKEN",
    "SELLER_ID",
    "MARKETPLACE_ID",
    "SP_API_ENDPOINT",
    "LWA_TOKEN_ENDPOINT",
    "SHIP_FROM_NAME",
    "SHIP_FROM_ADDRESS_LINE1",
    "SHIP_FROM_ADDRESS_LINE2",
    "SHIP_FROM_CITY",
    "SHIP_FROM_STATE",
    "SHIP_FROM_POSTAL_CODE",
    "SHIP_FROM_COUNTRY_CODE",
    "SHIP_FROM_PHONE"
  ];

  let message = "【Script Properties設定状況】\\n\\n";

  for (const key of keys) {
    const value = props.getProperty(key);
    const status = value ? "設定済み" : "未設定";
    const displayValue = value ? (key.includes("SECRET") || key.includes("TOKEN") ? "****" : value.substring(0, 20) + (value.length > 20 ? "..." : "")) : "-";
    message += `${key}: ${status}\\n  値: ${displayValue}\\n\\n`;
  }

  console.log(message.replace(/\\n/g, "\n"));
  Browser.msgBox("Script Properties確認", message, Browser.Buttons.OK);
}

/**
 * SP-API接続テスト（アクセストークン取得のみ）
 */
function spapi_testSpApiConnection() {
  try {
    console.log("=== SP-API接続テスト開始 ===");
    const accessToken = spapi_getAccessToken_();
    console.log("アクセストークン取得成功");
    Browser.msgBox("接続テスト成功", "SP-APIへの接続に成功しました。\\nアクセストークンを正常に取得できました。", Browser.Buttons.OK);
  } catch (error) {
    console.error("接続テスト失敗:", error.message);
    Browser.msgBox("接続テスト失敗", "SP-APIへの接続に失敗しました。\\n\\nエラー: " + error.message, Browser.Buttons.OK);
  }
}
