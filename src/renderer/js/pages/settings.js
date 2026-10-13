/* 页面：系统设置 */
(function () {
  const MM = window.MM;

  MM.pages.settings = {
    title: '系统设置',

    async render(view) {
      const [infoRes, settings, accountsRes] = await Promise.all([MM.api.info(), MM.loadSettings(true), MM.api.listAccounts()]);
      // IPC 统一返回 { ok, data } 信封，先拆开再取值
      const info = (infoRes && infoRes.ok && infoRes.data) || {};
      const s = settings || {};
      const accounts = accountsRes.ok ? accountsRes.data : [];
      const def = accounts.find((a) => a.isDefault) || accounts.find((a) => a.enabled !== false) || accounts[0];
      const throttle = s.defaultThrottle || { intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 };
      const live = s.sendMode === 'live';

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            配置全局发送策略。发信邮箱（地址、密码/授权码、SMTP 服务器）已独立到「发信邮箱配置」页面管理，可为不同任务指定不同发信地址。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="goto-accounts">管理发信邮箱</button>
            <button class="btn btn-primary" data-act="save-all">保存全部设置</button>
          </div>
        </div>

        <div class="callout ${live ? 'danger' : 'warn'}">
          <div>
            <b>当前发送模式：${live ? '真实发送' : '试运行（安全）'}</b><br/>
            ${
              live
                ? '推广任务会真实投递到收件人邮箱。请确认邮件模板内容、名单与发送频率均符合你所在地区的法规与邮箱服务商政策。'
                : '所有推广任务只做模拟投递，不会对真实收件人产生任何影响，适合先验证流程与模板效果。'
            }
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">发送模式</div>
            <span class="hint">影响所有推广任务（任务本身也可单独勾选试运行）</span>
          </div>
          <div class="panel-body">
            <div class="segmented" data-role="mode">
              <button data-mode="dryRun" class="${live ? '' : 'active'}">试运行（推荐先验证）</button>
              <button data-mode="live" class="${live ? 'active' : ''}">真实发送</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">发信邮箱账号 <span class="hint">共 ${accounts.length} 个，启用中 ${accounts.filter((a) => a.enabled !== false).length} 个</span></div>
            <div class="row-actions">
              <button class="btn btn-sm" data-act="test-default" ${def ? '' : 'disabled'}>测试默认账号</button>
              <button class="btn btn-sm btn-primary" data-act="goto-accounts">管理发信邮箱</button>
            </div>
          </div>
          <div class="panel-body">
            ${
              accounts.length
                ? `<div class="list-plain">
                     ${accounts
                       .map(
                         (a) => `<div class="list-row">
                           <div class="grow">
                             <div class="title">${MM.esc(a.email)} ${a.isDefault ? '<span class="badge badge-info">默认</span>' : ''}${a.enabled === false ? '<span class="badge badge-paused">已停用</span>' : ''}${a.pass ? '' : '<span class="badge badge-bounced">未配置密码</span>'}</div>
                             <div class="sub">${MM.esc(a.name)}　·　发信人：${MM.esc(a.fromName || '—')}　·　${MM.esc(a.host)}:${MM.esc(a.port)}　·　今日已发 ${a.todayUsed || 0}${a.dailyLimit ? ` / ${a.dailyLimit}` : ''}</div>
                           </div>
                         </div>`,
                       )
                       .join('')}
                   </div>`
                : '<div class="empty" style="padding:20px">尚未配置发信邮箱账号，点击右上角「管理发信邮箱」添加。</div>'
            }
            <div class="field" style="margin:14px 0 0;max-width:420px">
              <label class="field-label">发件方公司名 <span class="field-hint">（模板中的 {{发件方公司}}）</span></label>
              <input class="input" data-role="senderCompany" value="${MM.attr(s.senderCompany)}" placeholder="示例智能科技有限公司" />
            </div>
          </div>
        </div>

        <div class="grid-2 even">
          <div class="panel">
            <div class="panel-head"><div class="panel-title">默认发送节流</div></div>
            <div class="panel-body">
              <div class="form-grid">
                <div class="field"><label class="field-label">每封间隔（秒）</label>
                  <input class="input" type="number" min="0" data-role="intervalSeconds" value="${MM.attr(throttle.intervalSeconds)}" /></div>
                <div class="field"><label class="field-label">每日发送上限</label>
                  <input class="input" type="number" min="0" data-role="dailyLimit" value="${MM.attr(throttle.dailyLimit)}" /></div>
                <div class="field"><label class="field-label">失败重试次数</label>
                  <input class="input" type="number" min="0" data-role="maxRetries" value="${MM.attr(throttle.maxRetries)}" /></div>
              </div>
              <div class="field-hint">新建任务时会以这些值作为默认，仍然可以在任务中单独调整。每个发信账号还可以设置自己的日发送上限。</div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><div class="panel-title">退信保护</div></div>
            <div class="panel-body">
              <div class="field">
                <label class="switch"><input type="checkbox" data-role="bounceAutoPause" ${s.bounceAutoPause ? 'checked' : ''} /><span class="track"></span>退信率过高时自动暂停任务</label>
              </div>
              <div class="field" style="max-width:260px">
                <label class="field-label">触发阈值（累计退信数）</label>
                <input class="input" type="number" min="1" data-role="bouncePauseThreshold" value="${MM.attr(s.bouncePauseThreshold || 5)}" />
                <div class="field-hint">当单次执行中退信数超过阈值且退信率高于 30% 时自动暂停，保护发信信誉。</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div class="panel-title">邮件页脚</div></div>
          <div class="panel-body">
            <label class="switch" style="margin-bottom:10px"><input type="checkbox" data-role="appendFooter" ${s.appendFooter ? 'checked' : ''} /><span class="track"></span>在所有推广邮件正文末尾自动附加页脚</label>
            <textarea class="textarea" data-role="footerText" rows="3">${MM.esc(s.footerText || '')}</textarea>
            <div class="field-hint">建议保留退订说明，有助于降低被举报为垃圾邮件的风险。</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">数据与维护</div>
          </div>
          <div class="panel-body">
            <dl class="kv" style="margin-bottom:14px">
              <dt>数据文件</dt><dd class="mono" style="font-size:11.5px">${MM.esc(info.dataFile || '—')}</dd>
              <dt>应用版本</dt><dd>MailMaster v${MM.esc(info.version || '—')}　·　Electron ${MM.esc(info.electron || '—')}　·　${MM.esc(info.platform || '—')}</dd>
            </dl>
            <div class="form-grid c3">
              <div class="field"><label class="field-label">投递日志保留天数</label>
                <input class="input" type="number" min="0" data-role="logRetentionDays" value="${MM.attr(s.logRetentionDays || 180)}" />
                <div class="field-hint">0 表示永久保留</div></div>
            </div>
            <div class="pill-row">
              <button class="btn btn-sm" data-act="open-dir">打开数据目录</button>
              <button class="btn btn-sm" data-act="recompute">重新统计成功 / 失败 / 退信</button>
              <button class="btn btn-sm" data-act="prune">按保留期清理日志</button>
            </div>
          </div>
        </div>
      `;

      let mode = live ? 'live' : 'dryRun';

      view.querySelectorAll('[data-role="mode"] button').forEach((btn) => {
        btn.onclick = async () => {
          const next = btn.dataset.mode;
          if (next === mode) return;
          if (next === 'live') {
            const yes = await MM.confirm({
              title: '切换到真实发送模式',
              message: '切到真实发送后，所有未单独勾选试运行的推广任务都会<b>真实投递</b>到收件人邮箱（使用任务指定的发信邮箱账号）。确定继续吗？',
              confirmText: '我确认，切换为真实发送',
              danger: true,
            });
            if (!yes) return;
          }
          mode = next;
          view.querySelectorAll('[data-role="mode"] button').forEach((b) => b.classList.toggle('active', b === btn));
          const res = await MM.api.saveSettings({ sendMode: next });
          if (res.ok) {
            MM.state.settings = res.data;
            MM.toast(next === 'live' ? '已切换为真实发送模式' : '已切换为试运行模式', next === 'live' ? 'warn' : 'success');
            setTimeout(() => MM.renderRoute('settings'), 400);
          }
        };
      });

      const collect = () => ({
        senderCompany: view.querySelector('[data-role="senderCompany"]').value.trim(),
        sendMode: mode,
        defaultThrottle: {
          intervalSeconds: Number(view.querySelector('[data-role="intervalSeconds"]').value) || 0,
          dailyLimit: Number(view.querySelector('[data-role="dailyLimit"]').value) || 0,
          maxRetries: Number(view.querySelector('[data-role="maxRetries"]').value) || 0,
        },
        bounceAutoPause: view.querySelector('[data-role="bounceAutoPause"]').checked,
        bouncePauseThreshold: Number(view.querySelector('[data-role="bouncePauseThreshold"]').value) || 5,
        appendFooter: view.querySelector('[data-role="appendFooter"]').checked,
        footerText: view.querySelector('[data-role="footerText"]').value,
        logRetentionDays: Number(view.querySelector('[data-role="logRetentionDays"]').value) || 0,
      });

      view.querySelector('[data-act="goto-accounts"]').onclick = () => MM.navigate('accounts');

      view.querySelector('[data-act="save-all"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '保存中');
        const res = await MM.api.saveSettings(collect());
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        MM.state.settings = res.data;
        MM.toast('设置已保存', 'success');
      };

      const testBtn = view.querySelector('[data-act="test-default"]');
      if (testBtn) {
        testBtn.onclick = async (e) => {
          const restore = MM.spinBtn(e.target, '连接中');
          const res = await MM.api.testAccount({ id: def.id });
          restore();
          if (!res.ok) {
            MM.toast(res.error, 'error');
            return;
          }
          MM.toast(`${res.data.ok ? '✓' : '✕'} ${res.data.message}（${res.data.durationMs} ms）`, res.data.ok ? 'success' : 'error', 7000);
        };
      }

      view.querySelector('[data-act="open-dir"]').onclick = () => MM.api.openDataDir();
      view.querySelector('[data-act="recompute"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '统计中');
        const res = await MM.api.recomputeStats();
        restore();
        if (res.ok) MM.toast(`统计已重建：成功 ${res.data.success} · 失败 ${res.data.failed} · 退信 ${res.data.bounced}`, 'success');
      };
      view.querySelector('[data-act="prune"]').onclick = async (e) => {
        const days = Number(view.querySelector('[data-role="logRetentionDays"]').value) || 0;
        const yes = await MM.confirm({
          title: '清理历史投递日志',
          message: `将删除 ${days || 0} 天前的投递记录（0 天表示不清理）。该操作不可恢复。`,
          confirmText: '开始清理',
          danger: true,
        });
        if (!yes) return;
        const restore = MM.spinBtn(e.target, '清理中');
        const res = await MM.api.pruneLogs(days);
        restore();
        if (res.ok) MM.toast(`已清理 ${res.data.removed} 条历史记录`, 'success');
      };
    },
  };
})();
