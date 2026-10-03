/* 频道列表页：搜索 / 分组 / 状态筛选 / 排序 / 分页 / 单频道历史。
 * 数据全部来自 /api/channels、/api/groups、/api/channels/{id}/history，页面无内置样例。
 */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var ctx = {
    labels: {},
    page: 1,
    total: 0,
    limit: 100,
    loading: false,
    expandedId: null,
  };

  function request(method, url, body) {
    var opts = { method: method, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    // 同首页：用 location.origin 拼绝对地址，避免地址栏带账号密码时 fetch 报错
    var target = url.indexOf("http") === 0 ? url : location.origin + url;
    return fetch(target, opts).then(function (resp) {
      if (resp.status === 401) throw new Error("需要账号密码（401）");
      return resp.json().catch(function () {
        throw new Error("接口返回的不是 JSON（HTTP " + resp.status + "）");
      });
    });
  }

  function esc(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(epoch) {
    if (!epoch) return "-";
    var d = new Date(epoch * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtSpeed(kbps) {
    var v = Number(kbps || 0);
    if (!v) return "-";
    if (v >= 1024) return (v / 1024).toFixed(1) + " MB/s";
    return Math.round(v) + " KB/s";
  }

  function fmtMs(ms) {
    var v = Number(ms || 0);
    if (!v) return "-";
    if (v >= 1000) return (v / 1000).toFixed(2) + " s";
    return Math.round(v) + " ms";
  }

  function dash(v) {
    return v === null || v === undefined || v === "" ? "-" : v;
  }

  function statusClass(status) {
    if (status === "ok" || status === "audio_only") return "ok";
    if (status === "pending") return "pending";
    return "bad";
  }

  function yesno(v) {
    if (v === null || v === undefined) return "-";
    return Number(v) ? "有" : "无";
  }

  // ------------------------------------------------------------------
  function queryParams() {
    var sort = $("f-sort").value;
    var direction = $("f-direction").value;
    if (direction === "auto") direction = "";
    var params = [
      "q=" + encodeURIComponent($("f-q").value.trim()),
      "group=" + encodeURIComponent($("f-group").value),
      "source=" + encodeURIComponent($("f-source").value),
      "status=" + encodeURIComponent($("f-status").value),
      "sort=" + encodeURIComponent(sort),
      "direction=" + encodeURIComponent(direction),
      "page=" + ctx.page,
      "limit=" + ctx.limit,
      "include_inactive=" + ($("f-inactive").checked ? "true" : "false"),
    ];
    return params.join("&");
  }

  var SEGMENT_LABELS = {
    none: "无分片请求",
    ok: "分片全部可读",
    partial: "个别分片失败",
    failed: "分片全部失败",
    unknown: "HTTPS 隧道内不可见",
  };

  function segmentText(value) {
    if (value === null || value === undefined || value === "") return "-";
    return SEGMENT_LABELS[value] || value;
  }

  function hlsText(value) {
    if (value === null || value === undefined) return "非 HLS";
    return Number(value) ? "播放列表有效" : "播放列表无效";
  }

  // 「跳转 / 内容类型」合并成一格，鼠标移上去能看最终地址
  function redirectCell(item) {
    var hops = Number(item.redirect_count || 0);
    var final = item.final_url || "";
    var same = !final || final === item.url;
    var tip = "原始地址：" + (item.url || "") + "\n最终地址：" + (final || "（未取得）") +
      "\n内容类型：" + (item.content_type || "（未取得）") +
      "\nHLS：" + hlsText(item.hls_valid) + " / 分片：" + segmentText(item.segment_test);
    return (
      "<td title=\"" + esc(tip) + "\">" +
      (hops ? hops + " 次跳转" : same ? "未跳转" : "已跳转") +
      "</td>" +
      "<td title=\"" + esc(tip) + "\">" + esc(hlsText(item.hls_valid)) + "<br>" +
      esc(segmentText(item.segment_test)) + "</td>"
    );
  }

  function rowCells(item) {
    var ip = "-";
    if (item.family === "ipv6" && item.ipv6_addr) ip = "IPv6 " + item.ipv6_addr;
    else if (item.family === "ipv4" && item.ipv4_addr) ip = "IPv4 " + item.ipv4_addr;
    else if (item.ipv4_addr && item.ipv6_addr) ip = "v4/v6 已解析";
    else if (item.ipv4_addr) ip = "IPv4 " + item.ipv4_addr;
    else if (item.ipv6_addr) ip = "IPv6 " + item.ipv6_addr;

    var label = ctx.labels[item.status] || dash(item.status);
    var reason = item.failure_reason || "";
    var cells = [
      "<td title='" + esc(item.url) + "'>" + esc(item.name || "(未命名)") + "</td>",
      "<td>" + esc(dash(item.group_title)) + "</td>",
      "<td><span class='pill " + statusClass(item.status) + "'>" + esc(label) + "</span></td>",
      "<td>" + esc(dash(item.protocol)) + "</td>",
      "<td>" + esc(ip) + "</td>",
      "<td>" + esc(fmtSpeed(item.speed_kbps)) + "</td>",
      "<td>" + esc(fmtMs(item.latency_ms)) + "</td>",
      "<td>" + esc(fmtMs(item.elapsed_ms)) + "</td>",
      "<td>" + esc(dash(item.http_status)) + "</td>",
      redirectCell(item),
      "<td>" + yesno(item.has_video) + " / " + yesno(item.has_audio) + "</td>",
      "<td>" + esc((dash(item.v_codec) + "/" + dash(item.a_codec))) + "</td>",
      "<td>" + Number(item.success_count || 0) + " / " + Number(item.failure_count || 0) +
        (Number(item.consecutive_failures || 0) > 1 ? "（连败 " + item.consecutive_failures + "）" : "") + "</td>",
      "<td>" + (Number(item.success_count || 0) + Number(item.failure_count || 0)
        ? Math.round(Number(item.success_rate || 0) * 100) + "%" : "-") + "</td>",
      "<td>" + esc(fmtTime(item.last_tested_at)) + "</td>",
      "<td class='url' title='" + esc(reason) + "'>" + esc(reason || (item.status === "ok" || item.status === "audio_only" ? "可用" : "-")) + "</td>",
    ];
    return cells.join("");
  }

  function historyRow(row) {
    var label = ctx.labels[row.status] || dash(row.status);
    var tip = "最终地址：" + (row.final_url || "（未取得）") +
      "\n内容类型：" + (row.content_type || "（未取得）") +
      "\n详细输出：" + (row.test_error || row.failure_reason || "（无）");
    return (
      "<tr>" +
      "<td>" + esc(fmtTime(row.tested_at)) + "</td>" +
      "<td>" + esc(dash(row.family)) + "</td>" +
      "<td><span class='pill " + statusClass(row.status) + "'>" + esc(label) + "</span></td>" +
      "<td>" + esc(dash(row.http_status)) + "</td>" +
      "<td title=\"" + esc(tip) + "\">" + esc(Number(row.redirect_count || 0) + " 次") + "</td>" +
      "<td title=\"" + esc(tip) + "\">" + esc(hlsText(row.hls_valid)) + " / " +
        esc(segmentText(row.segment_test)) + "</td>" +
      "<td>" + esc(fmtMs(row.connect_ms)) + "</td>" +
      "<td>" + esc(fmtMs(row.first_packet_ms)) + "</td>" +
      "<td>" + esc(fmtSpeed(row.speed_kbps)) + "</td>" +
      "<td>" + yesno(row.has_video) + " / " + yesno(row.has_audio) + "</td>" +
      "<td class='url' title=\"" + esc(tip) + "\">" + esc(dash(row.failure_reason)) + "</td>" +
      "</tr>"
    );
  }

  function showHistory(anchor, channelId) {
    if (!anchor || !anchor.parentNode) return;
    request("GET", "/api/channels/" + channelId + "/history?limit=30")
      .then(function (data) {
        var tr = document.createElement("tr");
        var list = data.history || [];
        var body = list.length
          ? list.map(historyRow).join("")
          : "<tr><td colspan='11' class='note'>还没有测速记录</td></tr>";
        tr.innerHTML =
          "<td colspan='17'><div class='history'>历次测速（每个协议族各一行，含失败的尝试）" +
          "<table><thead><tr><th>时间</th><th>IP</th><th>状态</th><th>HTTP</th><th>跳转</th>" +
          "<th>播放列表/分片</th><th>连接</th>" +
          "<th>首包</th><th>速度</th><th>视/音</th><th>失败原因</th></tr></thead><tbody>" +
          body + "</tbody></table></div></td>";
        anchor.parentNode.insertBefore(tr, anchor.nextSibling);
      })
      .catch(function (err) {
        message("历史读取失败：" + err.message);
      });
  }

  function message(text) {
    $("summary").textContent = text;
  }

  function load() {
    if (ctx.loading) return Promise.resolve();
    ctx.loading = true;
    ctx.expandedId = null;
    return request("GET", "/api/channels?" + queryParams())
      .then(function (data) {
        ctx.total = data.total;
        var items = data.items || [];
        var tbody = $("rows");
        tbody.innerHTML = items.length
          ? items.map(function (item) { return "<tr data-id='" + item.id + "'>" + rowCells(item) + "</tr>"; }).join("")
          : "<tr><td colspan='17' class='note'>没有符合条件的频道。先去首页填写源地址并点「立即更新」。</td></tr>";
        Array.prototype.forEach.call(tbody.querySelectorAll("tr[data-id]"), function (tr) {
          tr.addEventListener("click", function () {
            var id = Number(tr.getAttribute("data-id"));
            var next = tr.nextSibling;
            if (next && next.parentNode) next.parentNode.removeChild(next);
            if (ctx.expandedId === id) {
              ctx.expandedId = null;
              return;
            }
            ctx.expandedId = id;
            showHistory(tr, id);
          });
        });
        var pages = Math.max(1, Math.ceil((data.total || 0) / ctx.limit));
        $("page-info").textContent = "第 " + data.page + " / " + pages + " 页，共 " + data.total + " 个频道";
        var st = statusCounts();
        message(
          "筛选结果 " + data.total + " 个" +
          (st.length ? "；本页状态：" + st.join("，") : "") +
          "（数字都来自数据库实测，未测过的频道状态为「未测试」）"
        );
      })
      .catch(function (err) {
        $("rows").innerHTML = "<tr><td colspan='17' class='note'>读取失败：" + esc(err.message) + "</td></tr>";
      })
      .then(function () {
        ctx.loading = false;
      });
  }

  function statusCounts() {
    var rows = document.querySelectorAll("#rows tr[data-id]");
    var counts = {};
    Array.prototype.forEach.call(rows, function (tr) {
      var pill = tr.querySelector(".pill");
      if (!pill) return;
      var text = pill.textContent;
      counts[text] = (counts[text] || 0) + 1;
    });
    return Object.keys(counts).map(function (k) { return k + " " + counts[k]; });
  }

  function loadGroups() {
    return request("GET", "/api/groups")
      .then(function (data) {
        var sel = $("f-group");
        var current = sel.value;
        sel.innerHTML = "<option value=''>全部分组</option>";
        (data.groups || []).forEach(function (g) {
          var opt = document.createElement("option");
          opt.value = g.group_title || "";
          opt.textContent = (g.group_title || "未分组") + "（" + (g.ok || 0) + "/" + g.total + "）";
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      })
      .catch(function () { /* 分组拉不到不影响列表本身 */ });
  }

  function loadSources() {
    return request("GET", "/api/sources")
      .then(function (data) {
        var sel = $("f-source");
        var current = sel.value;
        sel.innerHTML = "<option value=''>全部来源</option>";
        var configured = data.configured || [];
        (data.sources || []).forEach(function (s) {
          var url = s.source_url || "";
          var opt = document.createElement("option");
          opt.value = url || "__legacy__";
          opt.textContent =
            (url || "升级前的老数据（未记录来源）") + "（" + (s.ok || 0) + "/" + s.total + "）";
          sel.appendChild(opt);
        });
        // 配了但一条频道都没落地的源也给个选项，方便确认它确实没抓到东西
        configured.forEach(function (url) {
          var hit = (data.sources || []).some(function (s) { return (s.source_url || "") === url; });
          if (hit) return;
          var opt = document.createElement("option");
          opt.value = url;
          opt.textContent = url + "（0/0）";
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      })
      .catch(function () { /* 来源筛选拉不到不影响列表本身 */ });
  }

  function loadLabels() {
    return request("GET", "/api/status")
      .then(function (data) {
        ctx.labels = data.status_labels || {};
        var sel = $("f-status");
        // 保留 全部/可用/失效/未测试 四个汇总项，再按状态表补齐具体状态
        Object.keys(ctx.labels).forEach(function (key) {
          if (key === "ok" || key === "audio_only" || key === "pending") return;
          var opt = document.createElement("option");
          opt.value = key;
          opt.textContent = ctx.labels[key];
          sel.appendChild(opt);
        });
      })
      .catch(function () { /* 没有中文标签也能按原始状态码筛选 */ });
  }

  function init() {
    ["f-q", "f-group", "f-source", "f-status", "f-sort", "f-direction", "f-inactive"].forEach(function (id) {
      var el = $(id);
      el.addEventListener("change", function () {
        ctx.page = 1;
        load();
      });
    });
    var timer = null;
    $("f-q").addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        ctx.page = 1;
        load();
      }, 350);
    });
    $("f-limit").addEventListener("change", function () {
      ctx.limit = Number(this.value);
      ctx.page = 1;
      load();
    });
    $("prev").addEventListener("click", function () {
      if (ctx.page > 1) {
        ctx.page -= 1;
        load();
      }
    });
    $("next").addEventListener("click", function () {
      var pages = Math.max(1, Math.ceil(ctx.total / ctx.limit));
      if (ctx.page < pages) {
        ctx.page += 1;
        load();
      }
    });
    $("refresh").addEventListener("click", function () {
      loadGroups();
      loadSources();
      load();
    });

    Promise.all([loadLabels(), loadGroups(), loadSources()]).then(load);
    // 测速进行中时自动刷新，方便盯着看
    setInterval(function () {
      if (!ctx.expandedId && !document.hidden) load();
    }, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
