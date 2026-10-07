/* 管理首页：配置读写 + 任务触发 + 状态轮询。
 * 只依赖 /api/* 返回的 JSON，不在页面里编造任何数据。
 */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var state = {
    cfg: null,
    presets: { intervals: [10, 30, 60, 120, 360, 720, 1440], concurrency: [10, 20, 30, 40, 50, 100], ip_prefer: [] },
    timer: null,
    logsShown: 0,
    busy: false,
  };

  // ------------------------------------------------------------------
  // 通用工具
  // ------------------------------------------------------------------
  function request(method, url, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    // 用 location.origin 而不是直接传相对路径：万一有人把账号密码写进收藏地址
    // （http://admin:pwd@nas:9001/），相对路径会带上凭据导致 fetch 直接抛错。
    var target = url.indexOf("http") === 0 ? url : location.origin + url;
    return fetch(target, opts).then(function (resp) {
      if (resp.status === 401) throw new Error("需要账号密码（401）");
      return resp.json().catch(function () {
        throw new Error("接口返回的不是 JSON（HTTP " + resp.status + "）");
      });
    });
  }

  function getText(value) {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
  }

  function fmtTime(epoch) {
    if (!epoch) return "-";
    var d = new Date(epoch * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
    );
  }

  /* 与后端 pipeline.human() 保持一致：3分05秒 / 45秒 / 1小时02分 */
  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined || seconds < 0 || seconds > 259200) return "-";
    var s = Math.round(seconds);
    if (s < 60) return s + "秒";
    if (s < 3600) {
      var m = Math.floor(s / 60);
      var pad = s % 60 < 10 ? "0" + (s % 60) : String(s % 60);
      return m + "分" + pad + "秒";
    }
    var h = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    return h + "小时" + (mm < 10 ? "0" : "") + mm + "分";
  }

  function fmtSpeed(kbps) {
    var v = Number(kbps || 0);
    if (!v) return "-";
    if (v >= 1024) return (v / 1024).toFixed(1) + " MB/s";
    return Math.round(v) + " KB/s";
  }

  function message(text, cls) {
    var el = $("message");
    el.textContent = text || "";
    el.className = "message" + (cls ? " " + cls : "");
  }

  function kv(pairs) {
    return pairs
      .map(function (pair) {
        return "<span><i>" + esc(pair[0]) + "：</i>" + pair[1] + "</span>";
      })
      .join("");
  }

  function esc(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------
  // 表单
  // ------------------------------------------------------------------
  function fillSelect(sel, values, current, labelFn) {
    sel.innerHTML = "";
    values.forEach(function (value) {
      var opt = document.createElement("option");
      opt.value = value;
      opt.textContent = labelFn ? labelFn(value) : String(value);
      sel.appendChild(opt);
    });
    var found = values.map(String).indexOf(String(current));
    sel.value = found >= 0 ? values[found] : values[0];
  }

  function renderForm(cfg, presets) {
    $("source_urls").value = (cfg.source_urls || []).join("\n");

    var intervals = presets.intervals || [];
    var known = intervals.map(Number).indexOf(Number(cfg.update_interval_minutes));
    fillSelect($("interval_select"), known >= 0 ? intervals : [], cfg.update_interval_minutes, function (m) {
      var v = Number(m);
      if (v < 60) return v + " 分钟";
      if (v === 60) return "1 小时";
      if (v % 60 === 0) return v / 60 + " 小时";
      return v + " 分钟";
    });
    if (known < 0) {
      var opt = document.createElement("option");
      opt.value = String(cfg.update_interval_minutes);
      opt.textContent = cfg.update_interval_minutes + " 分钟";
      $("interval_select").appendChild(opt);
      $("interval_select").value = opt.value;
    }
    var customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "自定义…";
    $("interval_select").appendChild(customOpt);
    $("interval_custom").value = cfg.update_interval_minutes;
    syncIntervalVisibility();

    fillSelect($("concurrency"), presets.concurrency || [], cfg.concurrency, function (v) {
      return v + " 并发";
    });
    $("timeout_seconds").value = cfg.timeout_seconds;
    $("min_speed_kbps").value = cfg.min_speed_kbps;
    $("min_success_count").value = cfg.min_success_count;

    var preferSel = $("ip_prefer");
    preferSel.innerHTML = "";
    (presets.ip_prefer || []).forEach(function (item) {
      var o = document.createElement("option");
      o.value = item.value;
      o.textContent = item.label;
      preferSel.appendChild(o);
    });
    preferSel.value = cfg.ip_prefer || "auto";

    // 跳过失败源复选框
    var skipCheckbox = $("skip_failed_sources");
    if (skipCheckbox) {
      skipCheckbox.checked = !!cfg.skip_failed_sources;
    }
  }

  function syncIntervalVisibility() {
    var isCustom = $("interval_select").value === "__custom__";
    $("custom_interval").hidden = !isCustom;
  }

  // 文本框里一行一个源；空行和重复行由后端清洗，这里只做「有没有改动」的比较
  function textSources() {
    return ($("source_urls").value || "")
      .split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function savedSources(cfg) {
    return ((cfg || {}).source_urls || []).slice();
  }

  function collectForm() {
    var intervalRaw = $("interval_select").value;
    if (intervalRaw === "__custom__") intervalRaw = $("interval_custom").value;
    return {
      source_urls: $("source_urls").value,
      update_interval_minutes: Number(intervalRaw),
      concurrency: Number($("concurrency").value),
      timeout_seconds: Number($("timeout_seconds").value),
      min_speed_kbps: Number($("min_speed_kbps").value),
      min_success_count: Number($("min_success_count").value),
      ip_prefer: $("ip_prefer").value,
      skip_failed_sources: !!$("skip_failed_sources").checked,
    };
  }

  function loadConfig() {
    return request("GET", "/api/config").then(function (data) {
      state.cfg = data.config;
      if (data.presets) state.presets = data.presets;
      renderForm(data.config, data.presets || state.presets);
      if (data.auth_enabled === false) {
        message("提示：未设置 ADMIN_PASSWORD，管理页面当前任何人可访问", "bad");
      }
    });
  }

  function saveConfig() {
    var payload = collectForm();
    return request("POST", "/api/config", payload)
      .then(function (data) {
        if (data.ok) {
          state.cfg = data.config;
          var extra = data.next_run_in_seconds
            ? "，下次自动更新在 " + fmtDuration(data.next_run_in_seconds) + "后"
            : data.next_run_in_seconds === 0
            ? "，已立刻开始新一轮更新"
            : "";
          message("配置已保存" + extra, "ok");
          return true;
        }
        message((data.errors || ["保存失败"]).join("；"), "bad");
        return false;
      })
      .catch(function (err) {
        message("保存失败：" + err.message, "bad");
        return false;
      });
  }

  function trigger(url, btn, okText) {
    btn.disabled = true;
    return request("POST", url)
      .then(function (data) {
        message(data.ok ? data.message || okText : data.message || "未能启动任务", data.ok ? "ok" : "bad");
        if (data.ok) poll();
      })
      .catch(function (err) {
        message("操作失败：" + err.message, "bad");
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  // ------------------------------------------------------------------
  // 状态渲染
  // ------------------------------------------------------------------
  function renderProgress(st) {
    var card = $("progress-card");
    var running = !!st.running;
    state.busy = running;
    card.hidden = !running && !st.finished_at;
    $("btn-cancel").hidden = !running;
    $("btn-update").disabled = running;
    $("btn-test").disabled = running;

    var total = Number(st.total || 0);
    var done = Number(st.done || 0);
    var percent;
    if (running) {
      percent = total ? (done / total) * 100 : 0;
    } else if (total) {
      // 取消的那一轮：进度条要停在真实完成度上，不能画成 100%
      percent = (done / total) * 100;
    } else {
      percent = st.finished_at ? 100 : 0;
    }
    $("progress-bar").style.width = Math.max(0, Math.min(100, percent)).toFixed(1) + "%";
    if (!running && !total) {
      $("progress-detail").innerHTML = kv([["状态", "空闲，还没有运行过任务"]]);
      return;
    }
    if (!running) {
      $("progress-detail").innerHTML = kv([
        ["状态", esc(st.stage || "空闲")],
        ["本轮", st.kind === "scheduled" ? "定时任务" : st.kind === "manual" ? "手动更新" : st.kind === "test_only" ? "手动测速" : esc(st.kind || "-")],
        ["总数", total],
        ["成功", Number(st.ok || 0)],
        ["失败", Number(st.failed || 0)],
        ["结束时间", fmtTime(st.finished_at)],
      ]);
      return;
    }
    var pairs = [
      ["阶段", esc(st.stage || "-")],
      ["总数", total],
      ["已完成", done],
      ["成功", Number(st.ok || 0)],
      ["失败", Number(st.failed || 0)],
      ["进度", percent.toFixed(1) + "%"],
      ["速度", (Number(st.rate_per_second || 0)).toFixed(1) + " URLs/s"],
      ["预计剩余", fmtDuration(st.eta_seconds)],
    ];
    if (st.current) pairs.push(["当前频道", esc(st.current)]);
    $("progress-detail").innerHTML = kv(pairs);
  }

  function nextRunText(info) {
    if (!info) return "-";
    if (info.waiting_for_source) return "等待配置源地址";
    if (info.next_in_seconds === null || info.next_in_seconds === undefined) return "-";
    return fmtDuration(info.next_in_seconds) + "后";
  }

  function renderStats(data) {
    var st = data.stats || {};
    var boxes = [
      ["URL 总数", getText(st.source_count !== undefined && st.source_count !== null ? st.source_count : st.total)],
      ["有效 URL", getText(st.ok)],
      ["失效 URL", getText(st.bad)],
      ["成功率", (Number(st.success_rate || 0)).toFixed(1) + "%"],
      ["平均速度", fmtSpeed(st.avg_speed)],
      ["平均延迟", st.avg_latency ? Math.round(st.avg_latency) + " ms" : "-"],
    ];
    if (Number(st.pending || 0) > 0) boxes.splice(3, 0, ["未测试", st.pending]);
    $("stats").innerHTML = boxes
      .map(function (b) {
        return '<div class="stat"><b>' + esc(b[1]) + "</b><span>" + esc(b[0]) + "</span></div>";
      })
      .join("");

    $("status-detail").innerHTML = kv([
      ["订阅源", ((data.config || {}).source_urls || []).length + " 个地址"],
      ["源状态", esc((data.state || {}).source_state || "-")],
      ["源更新时间", fmtTime(st.last_source_update)],
      ["最后测速时间", fmtTime(st.last_tested_at)],
      ["列表生成时间", fmtTime(st.last_output_write)],
      ["下次自动更新", nextRunText(data.scheduler)],
      ["IPv4 / IPv6", (st.via_ipv4 || 0) + " / " + (st.via_ipv6 || 0)],
      ["更新周期", ((data.config || {}).update_interval_minutes || "-") + " 分钟"],
      ["并发 / 超时", ((data.config || {}).concurrency || "-") + " / " + ((data.config || {}).timeout_seconds || "-") + "s"],
      ["过滤阈值", "≥" + ((data.config || {}).min_speed_kbps || 0) + "KB/s，成功次数≥" + ((data.config || {}).min_success_count || 1)],
    ]);

    var note = [];
    var engineError = (data.state || {}).engine_error || "";
    if (engineError) {
      note.push("检测工具不可用，测速不会执行：" + esc(engineError) + "（镜像应自带 ffmpeg 与 ffprobe）。");
    }
    var ipv6 = data.ipv6 || {};
    if (ipv6.checked && ipv6.available === false) {
      note.push("容器内没有 IPv6 出口（" + esc(ipv6.detail || "") + "），IPv6 检测会记为连接失败；需要 IPv6 请用 host 网络。");
    } else if (ipv6.checked && ipv6.available === true) {
      note.push("已检测到 IPv6 出口：" + esc(ipv6.detail || ""));
    }
    var run = data.latest_run;
    if (run && run.error) note.push("最近一次运行报错：" + esc(run.error));
    if (run && run.cancelled) note.push("最近一次运行被手动取消");
    $("status-note").className = "note" + ((engineError || ipv6.available === false) ? " warn" : "");
    $("status-note").textContent = note.join(" ");
  }

  // 每个订阅源这一轮的情况：成功/失败、解析多少条、合并后留多少条、库里还挂着多少条
  function renderSources(st) {
    var rows = (st && st.sources) || [];
    var body = $("sources-body");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8">还没有下载过订阅源，点「立即更新」开始第一轮</td></tr>';
      $("sources-note").textContent = "";
      return;
    }
    body.innerHTML = rows
      .map(function (r) {
        var round;
        if (r.fetched === false) {
          round = '<span class="pill pending">' + (st.running ? "排队中" : "本轮未下载") + "</span>";
        } else if (r.ok) {
          round = '<span class="pill ok">成功</span>';
        } else {
          round = '<span class="pill bad">失败</span>';
        }
        var parsed = r.fetched === false ? "-" : Number(r.lines || 0);
        var kept = r.fetched === false ? "-" : Number(r.kept || 0);
        var cost = r.fetched === false ? "-" : Number(r.seconds || 0).toFixed(1) + "s";
        var note = r.error
          ? esc(r.error)
          : r.fetched === false
          ? "沿用库里的记录"
          : "HTTP " + (r.http_status || 200) + "，" + Number(r.size_kb || 0).toFixed(1) + " KB";
        var channels = Number(r.channels || 0) + " / " + Number(r.channels_ok || 0);
        return (
          "<tr>" +
          "<td>" + Number(r.index) + "</td>" +
          '<td class="url" title="' + esc(r.url) + '">' + esc(r.url) + "</td>" +
          "<td>" + round + "</td>" +
          "<td>" + parsed + "</td>" +
          "<td>" + kept + "</td>" +
          "<td>" + esc(channels) + "</td>" +
          "<td>" + cost + "</td>" +
          "<td>" + note + "</td>" +
          "</tr>"
        );
      })
      .join("");
    var dup = Number(st.merged_duplicates || 0);
    var failed = rows.filter(function (r) { return r.fetched !== false && !r.ok; }).length;
    var bits = [];
    if (failed) bits.push(failed + " 个源本轮失败，它们的频道沿用上次成功的结果");
    if (dup) bits.push("跨源合并掉 " + dup + " 个重复频道（保留实测最快的一条）");
    $("sources-note").textContent = bits.join("；");
    $("sources-note").className = "note" + (failed ? " warn" : "");
  }

  function renderOutputs(list) {
    var host = location.hostname;
    $("output-links").innerHTML = (list || [])
      .map(function (item) {
        var url = "http://" + host + ":" + location.port + "/" + item.name;
        var tail = item.exists ? Math.round(item.size / 1024) + " KB" : "尚未生成";
        return (
          '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(item.name) + "</a>" +
          '<span class="note" style="margin-right:14px">' + esc(tail) + "</span>"
        );
      })
      .join("");
  }

  function renderLogs(lines) {
    if (!lines || !lines.length) return;
    var joined = lines.join("\n");
    if (joined === state.logsShown) return;
    state.logsShown = joined;
    var box = $("logs");
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent = joined;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function poll() {
    return request("GET", "/api/status")
      .then(function (data) {
        renderProgress(data.state || {});
        renderStats(data);
        renderSources(data.state || {});
        renderOutputs(data.outputs);
        return request("GET", "/api/logs?lines=120").then(function (logData) {
          renderLogs(logData.lines);
        });
      })
      .catch(function (err) {
        message("状态获取失败：" + err.message, "bad");
      });
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  function init() {
    $("interval_select").addEventListener("change", syncIntervalVisibility);
    $("btn-save").addEventListener("click", function () {
      $("btn-save").disabled = true;
      saveConfig().then(function () {
        $("btn-save").disabled = false;
        poll();
      });
    });
    $("btn-update").addEventListener("click", function () {
      var btn = $("btn-update");
      if (textSources().join("\n") !== savedSources(state.cfg).join("\n")) {
        saveConfig().then(function (ok) {
          if (ok) trigger("/api/update", btn, "已开始更新");
        });
        return;
      }
      trigger("/api/update", btn, "已开始更新");
    });
    $("btn-test").addEventListener("click", function () {
      trigger("/api/test", $("btn-test"), "已开始测速");
    });
    $("btn-cancel").addEventListener("click", function () {
      trigger("/api/cancel", $("btn-cancel"), "已请求取消");
    });

    loadConfig()
      .catch(function (err) {
        message("配置读取失败：" + err.message, "bad");
      })
      .then(poll);
    state.timer = setInterval(poll, 1500);
    window.addEventListener("beforeunload", function () {
      if (state.timer) clearInterval(state.timer);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
