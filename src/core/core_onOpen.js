/**
 * onOpen.gs
 * スプレッドシート起動時にカスタムメニューを追加する
 */

/**
 * スプレッドシートを開いた時に実行される関数
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();

  ui.createMenu("利益確認")
    .addItem("商品管理へ転記", "tools_copyCheckedRowsToProductManagement")
    .addToUi();

  ui.createMenu("Amazonセラー機能")
    .addItem("商品登録", "spapi_registerSelectedProducts")
    .addItem("納品プラン作成", "spapi_createShipmentPlan")
    .addItem("販売詳細レポートを出力", "amazon_showMonthSelectionDialog")
    .addToUi();

  ui.createMenu("決算整理")
    .addItem("FBA在庫調整", "adjustingEntries_adjustFbaInventory")
    .addToUi();
}
