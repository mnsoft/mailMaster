/* 页面：总览看板 */
(function () {
  const MM = window.MM;

  const CHART_BAR_HEIGHT = 96; // 与 .trend 的可用高度对应（像素），保证柱高精确可控

  function trendChart(trend) {
    const max = Math.max(1, ...trend.map((t) => t.success + t.failed + t.bounced));
    const px = (v) => (v > 0 ? Math.max(3, Math.round((v / max) * CHART_BAR_HEIGHT)) : 0);
    return `<div class="trend">
      ${trend
        .map((t) => {
          const total = t.success + t.failed + t.bounced;
          return `<div class="trend-col" title="${t.date}｜成功 ${t.success} / 失败 ${t.failed} / 退信 ${t.bounced}">
            <div class="trend-bars">
              ${t.bounced ? `<div class="trend-seg bounced" style="height:${px(t.bounced)}px"></div>` : ''}
              ${t.failed ? `<div class="trend-seg failed" style="height:${px(t.failed)}px"></div>` : ''}
              ${t.success ? `<div class="trend-seg success" style="height:${px(t.success)}px"></div>` : ''}
              ${total === 0 ? '<div class="trend-seg" style="height:2px;background:#242d3b"></div>' : ''}
            </div>
            <div class="trend-label">${t.date.slice(5)}</div>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  function nextRunsList(overview) {
    if (!overview.nextRuns || !overview.nextRuns.length) {
      return '<div class="empty" style="padding:18px 0">当前没有已启用的定时推广任务</div>';
    }
    return `<div class="list-plain">
      ${overview.nextRuns
        .map(
          (r) => `<div class="list-row">
            <div class="grow">
              <div class="title">${MM.esc(r.name)}</div>
              <div class="sub">${MM.esc(MM.fmtDate(r.nextRunAt, true))} · ${MM.esc(MM.fmtRelative(r.nextRunAt).replace('前', '后'))}</div>
            </div>
            <span class="badge badge-info">待执行</span>
          </div>`,
        )
        .join('')}
    </div>`;
  }

  function runningProgress(campaigns) {
    const running = campaigns.filter((c) => c.running);
    if (!running.length) {
      return '<div class="empty" style="padding:20px 0">当前没有正在执行的推广任务</div>';
    }
    return `<div class="list-plain">
      ${running
        .map((c) => {
          const p = c.progress || {};
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          return `<div class="list-row" style="display:block">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
              <span class="running-dot"></span>
              <div class="grow"><div class="title">${MM.esc(c.name)}</div></div>
              <span class="mono" style="font-size:12px;color:var(--text-dim)">${p.done || 0} / ${p.total || 0}　${pct}%</span>
            </div>
            <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
            <div style="display:flex;gap:14px;margin-top:7px;font-size:11.5px;color:var(--text-faint)">
              <span>成功 ${p.success || 0}</span><span>失败 ${p.failed || 0}</span><span>退信 ${p.bounced || 0}</span>
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  function recentLogsTable(logs) {
    if (!logs || !logs.length) return '<div class="empty">暂无投递记录</div>';
    return `<table class="table">
      <thead><tr><th>时间</th><th>公司名 / 联系人</th><th>邮件地址</th><th>主题</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>
        ${logs
          .map(
            (l) => `<tr>
              <td class="mono" style="font-size:11.5px">${MM.esc(MM.fmtTimeShort(l.createdAt))}</td>
              <td><span class="cell-strong">${MM.esc(l.company || '—')}</span><span class="cell-sub">${MM.esc(l.contact || '')}</span></td>
              <td class="mono" style="font-size:11.5px">${MM.esc(l.email)}</td>
              <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${MM.esc(l.subject || '')}</td>
              <td>${MM.statusBadge(l.status)}${l.dryRun ? ' <span class="badge badge-draft">试运行</span>' : ''}</td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-faint);font-size:11.5px">${MM.esc(l.error || '—')}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  }

  MM.pages.dashboard = {
    title: '总览看板',
    async render(view) {
      const [overview, campaigns, settings] = await Promise.all([MM.loadOverview(), MM.loadCampaigns(), MM.loadSettings()]);
      if (!overview) throw new Error('无法读取总览数据');
      const today = overview.todayStats || {};
      const total = (overview.successCount || 0) + (overview.failedCount || 0) + (overview.bouncedCount || 0);

      const cd = MM.fmtCountdown(overview.nextRunAt);
      const dry = MM.sendMode(settings) !== 'live';

      view.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-desc">
              当前共收录 <b>${overview.userCount}</b> 位推广联系人，累计投递 <b>${MM.fmtNumber(total)}</b> 封推广邮件。
              下一次定时推广：<b>${overview.nextRunAt ? MM.esc(MM.fmtDate(overview.nextRunAt, true)) : '未设置'}</b>
            </div>
          </div>
          <div class="page-actions">
            <button class="btn" data-goto="contacts">管理邮件列表</button>
            <button class="btn" data-goto="campaigns">新建推广任务</button>
            <button class="btn btn-primary" data-quick-run>立即手动推广</button>
          </div>
        </div>

        ${
          dry
            ? `<div class="callout warn">⚠ 当前处于「试运行模式」：发送动作会被完整模拟并记录投递结果，但不会真正发出邮件。配置好发信账号后可在「系统设置」中切换为真实发送。</div>`
            : `<div class="callout danger">⚠ 当前为「真实发送模式」，推广任务将向真实收件人投递邮件，请确认模板与名单无误。</div>`
        }

        <div class="cards c6">
          ${MM.statCard({ label: '用户数量', value: overview.userCount, sub: `唯一邮箱 ${overview.uniqueEmailCount} · 可发送 ${overview.activeContactCount}` })}
          ${MM.statCard({ label: '推广数量', value: total, sub: `累计投递尝试 ${MM.fmtNumber(overview.totalAttempts)} 次` })}
          ${MM.statCard({ label: '成功数量', value: overview.successCount, sub: `成功率 ${MM.fmtPercent(overview.successCount, total)}`, tone: 's-success' })}
          ${MM.statCard({ label: '失败数量', value: overview.failedCount, sub: `占比 ${MM.fmtPercent(overview.failedCount, total)}`, tone: 's-danger' })}
          ${MM.statCard({ label: '退信数量', value: overview.bouncedCount, sub: `涉及 ${overview.bouncedContactCount} 个地址`, tone: 's-warn' })}
          ${MM.statCard({ label: '当前任务数量', value: overview.campaignCount, sub: `定时启用 ${overview.activeCampaignCount} · 执行中 ${overview.runningCampaignCount}`, tone: 's-info' })}
        </div>

        <div class="cards c3">
          ${MM.statCard({ label: '任务运行次数', value: overview.totalRuns, sub: '含手动与定时触发', tone: 's-info' })}
          ${MM.statCard({ label: '今日发送', value: today.total || 0, sub: `成功 ${today.success || 0} · 失败 ${today.failed || 0} · 退信 ${today.bounced || 0}` })}
          ${MM.statCard({
            label: '下次启动推广倒计时',
            value: `<span class="mono" id="cd-big" style="font-size:22px;color:${cd.idle ? 'var(--text-faint)' : '#9fd0ff'}">${cd.text}</span>`,
            sub: overview.nextRunName ? MM.esc(overview.nextRunName) : '暂无已启用的定时任务',
            tone: 's-success',
          })}
        </div>

        <div class="grid-2">
          <div>
            <div class="panel">
              <div class="panel-head">
                <div class="panel-title">近 14 天投递趋势 <span class="hint">（日维度）</span></div>
                <div class="legend">
                  <span><i style="background:linear-gradient(180deg,#34d17c,#22a35c)"></i>成功</span>
                  <span><i style="background:linear-gradient(180deg,#ff5d5d,#d33f3f)"></i>失败</span>
                  <span><i style="background:linear-gradient(180deg,#ffa93c,#d98a1f)"></i>退信</span>
                </div>
              </div>
              <div class="panel-body">${trendChart(overview.trend || [])}</div>
            </div>

            <div class="panel">
              <div class="panel-head">
                <div class="panel-title">最近投递记录</div>
                <button class="btn btn-sm btn-ghost" data-goto="delivery">查看全部 →</button>
              </div>
              <div class="panel-body tight">${recentLogsTable(overview.recentLogs)}</div>
            </div>
          </div>

          <div>
            <div class="panel">
              <div class="panel-head">
                <div class="panel-title">执行中的推广任务</div>
                <button class="btn btn-sm btn-ghost" data-goto="tasks">任务管理 →</button>
              </div>
              <div class="panel-body">${runningProgress(campaigns)}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><div class="panel-title">即将启动的定时任务</div></div>
              <div class="panel-body">${nextRunsList(overview)}</div>
            </div>

            <div class="panel">
              <div class="panel-head"><div class="panel-title">快捷操作</div></div>
              <div class="panel-body">
                <div class="pill-row">
                  <button class="btn btn-sm" data-goto="contacts">＋ 添加联系人</button>
                  <button class="btn btn-sm" data-goto="templates">＋ 新建模板</button>
                  <button class="btn btn-sm" data-goto="campaigns">＋ 临时推广任务</button>
                  <button class="btn btn-sm" data-goto="settings">SMTP 设置</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      // 大倒计时每秒刷新（本地计算，不重复请求主进程）
      const big = view.querySelector('#cd-big');
      MM.addTimer(() => {
        if (!MM.state.overview) return;
        const c = MM.fmtCountdown(MM.state.overview.nextRunAt);
        if (big) {
          big.textContent = c.text;
          big.style.color = c.idle ? 'var(--text-faint)' : '#9fd0ff';
        }
      }, 1000);

      view.querySelectorAll('[data-goto]').forEach((el) => {
        el.onclick = () => MM.navigate(el.dataset.goto);
      });
      view.querySelector('[data-quick-run]').onclick = () => {
        const manual = (MM.state.campaigns || []).find((c) => c.kind === 'manual') || MM.state.campaigns[0];
        if (!manual) {
          MM.toast('还没有推广任务，请先创建', 'warn');
          return;
        }
        MM.navigate('campaigns');
        MM.toast(`已跳转到推广任务页，可对「${manual.name}」直接点击执行`, 'info');
      };
    },

    onEvent(payload) {
      if (payload.type === 'campaign' || payload.type === 'log' || payload.type === 'overview-dirty') {
        MM.state.dirty.overview = true;
      }
    },
  };
})();
