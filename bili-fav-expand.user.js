// ==UserScript==
// @name         Bilibili 收藏夹取消侧栏滚动
// @namespace    aspi-rin
// @version      0.1
// @description  展开“我创建的收藏夹”侧栏
// @author       aspi-rin
// @match        https://space.bilibili.com/*/favlist*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  GM_addStyle(`
    .fav-collapse-wrap {
      max-height: none !important;
      overflow-y: visible !important;
      overflow-x: visible !important;
    }
  `);
})();
