// ==UserScript==
// @name         Shopee Purchase Summary TH (Fixed Status Bug)
// @namespace    local.shopee.summary
// @version      2.0.1
// @description  สรุปยอดคำสั่งซื้อ Shopee ดึงข้อมูลอัตโนมัติผ่าน API หรือสแกนหน้าเว็บ/ไฟล์ HTML พร้อมแยกรายปีและส่งออก CSV
// @match        https://shopee.co.th/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (document.getElementById('shopee-summary-host')) return;

  const host = document.createElement('div');
  host.id = 'shopee-summary-host';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
  <style>
    :host {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #333;
    }
    .panel {
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.18);
      padding: 16px;
      width: min(420px, calc(100vw - 40px));
      max-height: 85vh;
      overflow-y: auto;
      box-sizing: border-box;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      border-bottom: 1px solid #f0f0f0;
      padding-bottom: 8px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      color: #ee4d2d;
      font-weight: 600;
    }
    button {
      background: #ee4d2d;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    button:hover { background: #d73211; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    button.secondary {
      background: #f5f5f5;
      color: #555;
      border: 1px solid #ddd;
    }
    button.secondary:hover { background: #e8e8e8; }
    .btn-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .form-group {
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    select, input[type="file"] {
      font-size: 12px;
      padding: 4px 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    pre {
      background: #f9f9f9;
      border: 1px solid #eee;
      border-radius: 6px;
      padding: 10px;
      white-space: pre-wrap;
      font-size: 12px;
      margin: 10px 0;
      max-height: 220px;
      overflow-y: auto;
    }
    .muted {
      color: #777;
      font-size: 11px;
      margin: 4px 0;
    }
    [hidden] { display: none !important; }
  </style>

  <div class="panel">
    <div class="header">
      <h2>สรุปยอดซื้อ Shopee TH</h2>
      <button id="toggle-btn" class="secondary" style="padding: 2px 8px; font-size: 11px;">ย่อ</button>
    </div>
    <div id="content">
      <div class="btn-group">
        <button id="fetch-api-btn">ดึงอัตโนมัติ (API)</button>
        <button id="scan-dom-btn" class="secondary">อ่านหน้าปัจจุบัน</button>
        <button id="stop-btn" class="secondary" hidden>หยุดดึง</button>
        <button id="clear-btn" class="secondary">ล้างข้อมูล</button>
      </div>

      <div class="form-group">
        <label for="status-filter">สถานะ:</label>
        <select id="status-filter">
          <option value="done">สำเร็จแล้ว / ให้คะแนนแล้ว</option>
          <option value="all">ทุกสถานะ (รวมยกเลิก/คืนเงิน)</option>
        </select>
      </div>

      <div class="form-group">
        <label>นำเข้าไฟล์ HTML:</label>
        <input id="file-input" type="file" accept=".html,.htm,text/html">
      </div>

      <pre id="summary-view">กรุณากด "ดึงอัตโนมัติ (API)" เพื่อเริ่มดึงประวัติคำสั่งซื้อทั้งหมด</pre>

      <div class="btn-group">
        <button id="csv-btn">ดาวน์โหลด CSV</button>
      </div>
      <p id="status-msg" class="muted"></p>
      <p class="muted">โหมด API ทำงานผ่าน Session ที่ล็อกอินอยู่โดยตรง ปลอดภัย และไม่มีการส่งข้อมูลออกภายนอก</p>
    </div>
  </div>
  `;

  const $ = selector => root.querySelector(selector);
  const orders = new Map();
  let currentSource = '';
  let isFetching = false;
  let abortController = null;

  const formatCurrency = val => (val || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ฟังก์ชันแปลงสถานะให้เป็นข้อความ String เสมอ
  function extractStatus(order) {
    if (typeof order.status === 'string') return order.status;
    if (typeof order.status_label === 'string') return order.status_label;
    if (order.status && typeof order.status.text === 'string') return order.status.text;
    if (order.status && typeof order.status.status_label === 'string') return order.status.status_label;
    if (order.status && typeof order.status.label === 'string') return order.status.label;

    const infoCard = order.info_card;
    if (infoCard) {
      if (typeof infoCard.status === 'string') return infoCard.status;
      if (typeof infoCard.status_label === 'string') return infoCard.status_label;
      if (infoCard.status && typeof infoCard.status.text === 'string') return infoCard.status.text;
      if (infoCard.order_list_cards?.[0]?.status) {
        const s = infoCard.order_list_cards[0].status;
        if (typeof s === 'string') return s;
        if (typeof s.text === 'string') return s.text;
      }
    }

    const code = order.status?.status_code ?? (typeof order.status === 'number' ? order.status : (order.list_type ?? order.status_code));
    if (code === 3) return 'สำเร็จแล้ว';
    if (code === 4) return 'ยกเลิกแล้ว';
    if (code === 5) return 'คืนเงิน/คืนสินค้า';
    if (code === 2 || code === 8) return 'ที่ต้องจัดส่ง';
    if (code === 9) return 'ที่ต้องได้รับ';
    if (code !== undefined) return `สถานะ ${code}`;

    return 'สำเร็จแล้ว';
  }

  // แปลงข้อมูลจาก Shopee API
  function parseApiOrder(order) {
    const id = String(order.order_id || order.info_card?.order_id || order.order_sn || '');

    // ดึงชื่อร้านค้า
    const firstCard = order.info_card?.order_list_cards?.[0];
    const shop = String(firstCard?.shop_info?.shop_name || firstCard?.shop_info?.username || order.shop_info?.shop_name || '-');

    // จำนวนชิ้นและชื่อสินค้า
    let pieces = 0;
    const itemNames = [];
    const cards = order.info_card?.order_list_cards || [];

    for (const card of cards) {
      let items = card.items || [];
      if (!items.length && card.product_info?.item_groups) {
        for (const grp of card.product_info.item_groups) {
          if (grp.items) items.push(...grp.items);
        }
      }
      for (const item of items) {
        const qty = Number(item.amount || item.quantity || 1);
        pieces += isNaN(qty) ? 1 : qty;
        if (item.name) itemNames.push(String(item.name).trim());
      }
    }

    // Shopee API บันทึกยอดเงินโดยคูณด้วย 100,000 (1 THB = 100,000)
    let cents = null;
    const rawTotal = order.info_card?.final_total ?? order.final_total;
    if (typeof rawTotal === 'number') {
      cents = Math.round((rawTotal / 100000) * 100);
    }

    const statusLabel = extractStatus(order);

    // วันที่สั่งซื้อ
    const timestamp = order.create_time || order.shipping_confirm_time;
    const dateObj = timestamp ? new Date(timestamp * 1000) : null;
    const dateStr = dateObj ? dateObj.toLocaleDateString('th-TH') : '-';
    const yearMonth = dateObj ? `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}` : 'ไม่ระบุ';

    return {
      id,
      date: dateStr,
      yearMonth,
      shop,
      status: statusLabel,
      pieces: pieces || 1,
      cents,
      itemNames: itemNames.join(' | '),
      lines: cards.length || 1,
      source: 'API'
    };
  }

  // ตัวอ่านหน้าจอ DOM หรือไฟล์ HTML (Fallback)
  function parseHtml(doc) {
    const records = [];
    const orderLinks = [...doc.querySelectorAll('a[href*="/user/purchase/order/"]')];
    const seenContainers = new Set();

    for (const link of orderLinks) {
      const match = link.getAttribute('href')?.match(/\/order\/(\d+)/);
      if (!match) continue;
      const orderId = match[1];

      let curr = link.parentElement;
      let card = null;
      while (curr && curr !== doc.body && curr !== doc.documentElement) {
        const internalIds = new Set(
          [...curr.querySelectorAll('a[href*="/user/purchase/order/"]')]
            .map(a => a.getAttribute('href')?.match(/\/order\/(\d+)/)?.[1])
            .filter(Boolean)
        );
        if (internalIds.size === 1 && internalIds.has(orderId)) {
          card = curr;
          curr = curr.parentElement;
        } else {
          break;
        }
      }

      if (!card || seenContainers.has(card)) continue;
      seenContainers.add(card);

      const text = card.textContent || '';

      let cents = null;
      const prices = [...text.matchAll(/฿\s*([\d,]+(?:\.\d{1,2})?)/g)];
      if (prices.length > 0) {
        const lastVal = parseFloat(prices[prices.length - 1][1].replace(/,/g, ''));
        if (!isNaN(lastVal)) cents = Math.round(lastVal * 100);
      }

      let pieces = 0;
      const quantities = [...text.matchAll(/[x×]\s*(\d+)/gi)];
      if (quantities.length > 0) {
        pieces = quantities.reduce((acc, q) => acc + parseInt(q[1], 10), 0);
      }

      let status = 'สำเร็จแล้ว';
      if (text.includes('ยกเลิกแล้ว')) status = 'ยกเลิกแล้ว';
      else if (text.includes('คืนเงิน') || text.includes('คืนสินค้า')) status = 'คืนเงิน/คืนสินค้า';
      else if (text.includes('ที่ต้องได้รับ') || text.includes('กำลังจัดส่ง')) status = 'กำลังจัดส่ง';

      const shopEl = card.querySelector('a[href*="/shop/"]') || card.querySelector('a');
      const shop = shopEl ? shopEl.textContent.trim().slice(0, 30) : '-';

      records.push({
        id: orderId,
        date: '-',
        yearMonth: 'ไม่ระบุ',
        shop,
        status,
        pieces: pieces || 1,
        cents,
        itemNames: '',
        lines: 1,
        source: 'HTML'
      });
    }

    return records;
  }

  function getFilteredOrders() {
    const filter = $('#status-filter').value;
    return [...orders.values()].filter(o => {
      if (filter === 'all') return true;
      const statusStr = String(o.status || '');
      return ['สำเร็จ', 'ให้คะแนน', '3'].some(s => statusStr.includes(s));
    });
  }

  function render() {
    const list = getFilteredOrders();
    const totalBaht = list.reduce((sum, o) => sum + (o.cents ? o.cents / 100 : 0), 0);
    const totalPieces = list.reduce((sum, o) => sum + (o.pieces || 0), 0);
    const missingPriceCount = list.filter(o => o.cents === null).length;

    // จัดกลุ่มตามปี/เดือน
    const monthlyMap = new Map();
    for (const item of list) {
      if (item.yearMonth && item.yearMonth !== 'ไม่ระบุ') {
        const prev = monthlyMap.get(item.yearMonth) || { count: 0, sum: 0 };
        prev.count++;
        prev.sum += (item.cents ? item.cents / 100 : 0);
        monthlyMap.set(item.yearMonth, prev);
      }
    }

    let monthlyText = '';
    if (monthlyMap.size > 0) {
      monthlyText = '\n--- ยอดซื้อแยกตามเดือน ---\n';
      const sortedKeys = [...monthlyMap.keys()].sort().reverse();
      for (const ym of sortedKeys) {
        const data = monthlyMap.get(ym);
        monthlyText += `${ym}: ${data.count} รายการ | ${formatCurrency(data.sum)} บาท\n`;
      }
    }

    $('#summary-view').textContent =
      `แหล่งข้อมูล: ${currentSource || 'ยังไม่มี'}\n` +
      `พบทั้งหมด: ${orders.size.toLocaleString()} รายการ\n` +
      `ตรงตามเงื่อนไข: ${list.length.toLocaleString()} รายการ\n` +
      `จำนวนสินค้ารวม: ${totalPieces.toLocaleString()} ชิ้น\n` +
      `ยอดเงินรวม: ${formatCurrency(totalBaht)} บาท\n` +
      (missingPriceCount ? `(อ่านยอดเงินไม่ได้: ${missingPriceCount} รายการ)\n` : '') +
      monthlyText;
  }

  // ดึงข้อมูลคำสั่งซื้อผ่าน Shopee API
  async function startApiFetch() {
    if (isFetching) return;
    isFetching = true;
    abortController = new AbortController();

    $('#fetch-api-btn').disabled = true;
    $('#scan-dom-btn').disabled = true;
    $('#stop-btn').hidden = false;
    $('#status-msg').textContent = 'กำลังเริ่มเชื่อมต่อ API ของ Shopee...';

    const limit = 20;
    let offset = 0;
    const filter = $('#status-filter').value;
    const listTypeParam = (filter === 'done') ? '&list_type=3' : '';

    orders.clear();
    currentSource = 'Shopee Internal API';

    try {
      while (isFetching) {
        const url = `${window.location.origin}/api/v4/order/get_order_list?limit=${limit}&offset=${offset}${listTypeParam}`;
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          credentials: 'include',
          signal: abortController.signal
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} (กรุณารีเฟรชหน้าเว็บและตรวจสอบการล็อกอิน)`);
        }

        const data = await res.json();
        const details = data?.data?.details_list;

        if (!details || details.length === 0) {
          break;
        }

        for (const item of details) {
          const parsed = parseApiOrder(item);
          if (parsed.id) orders.set(parsed.id, parsed);
        }

        $('#status-msg').textContent = `กำลังโหลด... อ่านได้แล้ว ${orders.size.toLocaleString()} คำสั่งซื้อ`;
        render();

        const nextOffset = data.data?.next_offset;
        if (nextOffset === undefined || nextOffset < 0 || nextOffset === offset) {
          break;
        }

        offset = nextOffset;
        await new Promise(r => setTimeout(r, 350));
      }

      $('#status-msg').textContent = `ดึงข้อมูลเสร็จสมบูรณ์ ทั้งหมด ${orders.size.toLocaleString()} รายการ`;
    } catch (err) {
      if (err.name === 'AbortError') {
        $('#status-msg').textContent = `หยุดการดึงข้อมูลแล้ว (ได้ข้อมูลมา ${orders.size.toLocaleString()} รายการ)`;
      } else {
        $('#status-msg').textContent = `เกิดข้อผิดพลาด: ${err.message}`;
      }
    } finally {
      isFetching = false;
      $('#fetch-api-btn').disabled = false;
      $('#scan-dom-btn').disabled = false;
      $('#stop-btn').hidden = true;
      render();
    }
  }

  $('#fetch-api-btn').onclick = startApiFetch;

  $('#stop-btn').onclick = () => {
    isFetching = false;
    if (abortController) abortController.abort();
  };

  $('#scan-dom-btn').onclick = () => {
    const records = parseHtml(document);
    records.forEach(r => orders.set(r.id, r));
    currentSource = 'สแกนหน้าจอ DOM ปัจจุบัน';
    render();
    $('#status-msg').textContent = `อ่านจากหน้าจอได้ ${records.length} รายการ`;
  };

  $('#file-input').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const records = parseHtml(doc);
      orders.clear();
      records.forEach(r => orders.set(r.id, r));
      currentSource = `ไฟล์: ${file.name}`;
      render();
      $('#status-msg').textContent = `นำเข้าสำเร็จ ${records.length} รายการ`;
    } catch (err) {
      $('#status-msg').textContent = `อ่านไฟล์ไม่ได้: ${err.message}`;
    }
    e.target.value = '';
  };

  $('#status-filter').onchange = () => {
    render();
    $('#status-msg').textContent = 'เปลี่ยนมุมมองสถานะแล้ว';
  };

  $('#clear-btn').onclick = () => {
    orders.clear();
    currentSource = '';
    render();
    $('#status-msg').textContent = 'ล้างข้อมูลเรียบร้อย';
  };

  $('#toggle-btn').onclick = () => {
    const content = $('#content');
    content.hidden = !content.hidden;
    $('#toggle-btn').textContent = content.hidden ? 'เปิด' : 'ย่อ';
  };

  $('#csv-btn').onclick = () => {
    const list = getFilteredOrders();
    if (!list.length) {
      $('#status-msg').textContent = 'ไม่มีข้อมูลสำหรับส่งออก';
      return;
    }

    const esc = val => '"' + String(val ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
    const headers = ['Order ID', 'Date', 'Shop', 'Status', 'Pieces', 'Total (THB)', 'Items'];
    const rows = list.map(o => [
      o.id,
      o.date,
      o.shop,
      o.status,
      o.pieces,
      o.cents !== null ? (o.cents / 100).toFixed(2) : '',
      o.itemNames
    ]);

    const csvContent = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff', csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shopee-purchases-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();