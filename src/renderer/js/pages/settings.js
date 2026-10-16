/* 页面：系统设置 */
(function () {
  const MM = window.MM;

  MM.pages.settings = {
    title: '系统设置',

    async render(view) {
      const [infoRes, settings, accountsRes, pacingRes] = await Promise.all([
        MM.api.info(),
        MM.loadSettings(true),
        MM.api.listAccounts(),
        MM.api.pacingMeta(),
      ]);
      const presets = (pacingRes && pacingRes.ok && pacingRes.data && pacingRes.data.presets) || [];
      // IPC 统一返回 { ok, data } 信封，先拆开再取值
      const info = (infoRes && infoRes.ok && infoRes.data) || {};
      const s = settings || {};
      const accounts = accountsRes.ok ? accountsRes.data : [];
      const def = accounts.find((a) => a.isDefault) || accounts.find((a) => a.enabled !== false) || accounts[0];
      // 默认发送节奏：补全所有字段，兼容旧数据里只有 intervalSeconds 的写法
      const throttle = Object.assign(
        { mode: 'fixed', intervalSeconds: 10, delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 0, burstMinSeconds: 180, burstMaxSeconds: 420, hourlyLimit: 0, dailyLimit: 200, maxRetries: 1 },
        s.defaultThrottle || {},
      );
      const live = s.sendMode === 'live';
      const imapAccounts = accounts.filter((a) => a.provider !== 'tencent-ses' && a.imap?.enabled);

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

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">默认发送节奏 <span class="hint">新建推广任务时的默认值，任务内仍可单独调整</span></div>
            <div class="panel-head-actions">
              <div class="var-picker" data-role="pace-presets">
                ${presets.map((p) => `<button class="var-chip" data-preset="${p.key}" title="${MM.attr(p.hint)}">${MM.esc(p.label)}</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="panel-body">
            <div class="field" style="margin-bottom:10px">
              <label class="field-label">间隔模式</label>
              <div class="segmented" data-role="pace-mode">
                <button data-mode="fixed" class="${throttle.mode === 'random' ? '' : 'active'}">固定间隔（可预期）</button>
                <button data-mode="random" class="${throttle.mode === 'random' ? 'active' : ''}">随机延迟（拟人，推荐）</button>
              </div>
              <div class="field-hint">随机延迟让每封邮件之间的等待时间在区间内浮动，避免等间隔的机器特征，降低触发垃圾邮件频率阈值与限流封号的风险。</div>
            </div>

            <div class="form-grid c3">
              <div class="field ${throttle.mode === 'random' ? 'hidden' : ''}" data-role="pace-fixed">
                <label class="field-label">每封间隔（秒）</label>
                <input class="input" type="number" min="0" data-role="intervalSeconds" value="${MM.attr(throttle.intervalSeconds)}" /></div>
              <div class="field ${throttle.mode === 'random' ? '' : 'hidden'}" data-role="pace-random-min">
                <label class="field-label">随机最小延迟（秒）</label>
                <input class="input" type="number" min="0" data-role="delayMinSeconds" value="${MM.attr(throttle.delayMinSeconds)}" /></div>
              <div class="field ${throttle.mode === 'random' ? '' : 'hidden'}" data-role="pace-random-max">
                <label class="field-label">随机最大延迟（秒）</label>
                <input class="input" type="number" min="0" data-role="delayMaxSeconds" value="${MM.attr(throttle.delayMaxSeconds)}" /></div>
            </div>

            <div class="form-grid c3" style="margin-top:6px">
              <div class="field"><label class="field-label">每多少封后长停顿（0 = 不启用）</label>
                <input class="input" type="number" min="0" data-role="burstEvery" value="${MM.attr(throttle.burstEvery)}" /></div>
              <div class="field"><label class="field-label">长停顿最短（秒）</label>
                <input class="input" type="number" min="0" data-role="burstMinSeconds" value="${MM.attr(throttle.burstMinSeconds)}" /></div>
              <div class="field"><label class="field-label">长停顿最长（秒）</label>
                <input class="input" type="number" min="0" data-role="burstMaxSeconds" value="${MM.attr(throttle.burstMaxSeconds)}" /></div>
            </div>

            <div class="form-grid c3" style="margin-top:6px">
              <div class="field"><label class="field-label">每小时发送上限（0 = 不限）</label>
                <input class="input" type="number" min="0" data-role="hourlyLimit" value="${MM.attr(throttle.hourlyLimit)}" />
                <div class="field-hint">超过后自动等待到下一个小时窗口继续</div></div>
              <div class="field"><label class="field-label">每日发送上限（0 = 不限）</label>
                <input class="input" type="number" min="0" data-role="dailyLimit" value="${MM.attr(throttle.dailyLimit)}" /></div>
              <div class="field"><label class="field-label">失败重试次数</label>
                <input class="input" type="number" min="0" max="5" data-role="maxRetries" value="${MM.attr(throttle.maxRetries)}" /></div>
            </div>

            <div class="stat-inline" data-role="pace-preview">—</div>
            <div class="field-hint">每个发信账号还可以设置自己的日发送上限；推广任务页在保存前也会按命中人数估算整批耗时。</div>
          </div>
        </div>

        <div class="grid-2 even">
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

          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">IMAP 退信监听 <span class="hint">全局开关，账号级配置在「发信邮箱配置」中</span></div>
              <button class="btn btn-sm" data-act="goto-bounce">查看监听详情</button>
            </div>
            <div class="panel-body">
              <div class="field">
                <label class="switch"><input type="checkbox" data-role="imapAutoCheck" ${s.imapAutoCheck !== false ? 'checked' : ''} /><span class="track"></span>开启自动轮询检查退信</label>
                <div class="field-hint">关闭后只在你点击「退信监听」页的「立即检查退信」时扫描。</div>
              </div>
              <div class="form-grid">
                <div class="field"><label class="field-label">轮询间隔（分钟）</label>
                  <input class="input" type="number" min="1" max="1440" data-role="imapPollMinutes" value="${MM.attr(s.imapPollMinutes || 5)}" /></div>
                <div class="field"><label class="field-label">自动标记的退信类型</label>
                  <select class="select" data-role="imapBounceType">
                    <option value="hard" ${s.imapBounceType !== 'all' ? 'selected' : ''}>仅硬退信 / 被拒收（推荐）</option>
                    <option value="all" ${s.imapBounceType === 'all' ? 'selected' : ''}>所有退信（含临时退信）</option>
                  </select></div>
              </div>
              <div class="field">
                <label class="switch"><input type="checkbox" data-role="imapAutoMarkBounce" ${s.imapAutoMarkBounce !== false ? 'checked' : ''} /><span class="track"></span>识别到退信后自动标记地址并从发送列表剔除</label>
              </div>
              <div class="callout ${imapAccounts.length ? '' : 'warn'}" style="margin:0">
                ${
                  imapAccounts.length
                    ? `已开启监听的账号：${imapAccounts.map((a) => MM.esc(a.email)).join('、')}。上次检查 ${
                        s.imapLastCheckAt ? MM.esc(MM.fmtDate(s.imapLastCheckAt, true)) : '尚未执行'
                      }。`
                    : '还没有任何账号开启 IMAP 退信监听。请前往「发信邮箱配置」→ 编辑普通邮箱账号 → 打开「退信监听（IMAP）」并填写收信服务器。'
                }
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

      // ----- 默认发送节奏 -----
      let paceMode = throttle.mode === 'random' ? 'random' : 'fixed';
      const paceFixedBox = view.querySelector('[data-role="pace-fixed"]');
      const paceRandomMinBox = view.querySelector('[data-role="pace-random-min"]');
      const paceRandomMaxBox = view.querySelector('[data-role="pace-random-max"]');

      const collectThrottle = () => ({
        mode: paceMode,
        intervalSeconds: Number(view.querySelector('[data-role="intervalSeconds"]').value) || 0,
        delayMinSeconds: Number(view.querySelector('[data-role="delayMinSeconds"]').value) || 0,
        delayMaxSeconds: Number(view.querySelector('[data-role="delayMaxSeconds"]').value) || 0,
        burstEvery: Number(view.querySelector('[data-role="burstEvery"]').value) || 0,
        burstMinSeconds: Number(view.querySelector('[data-role="burstMinSeconds"]').value) || 0,
        burstMaxSeconds: Number(view.querySelector('[data-role="burstMaxSeconds"]').value) || 0,
        hourlyLimit: Number(view.querySelector('[data-role="hourlyLimit"]').value) || 0,
        dailyLimit: Number(view.querySelector('[data-role="dailyLimit"]').value) || 0,
        maxRetries: Number(view.querySelector('[data-role="maxRetries"]').value) || 0,
      });

      /** 用主进程的节奏模块生成中文说明，保证界面文案与实际执行逻辑一致 */
      const refreshPacePreview = async () => {
        const box = view.querySelector('[data-role="pace-preview"]');
        if (!box || !box.isConnected) return;
        const res = await MM.api.paceEstimate({ throttle: collectThrottle(), total: 0 });
        if (!res.ok || !box.isConnected) return;
        box.className = 'stat-inline ok';
        box.innerHTML = `当前默认节奏：<b>${MM.esc(res.data.describe)}</b>`;
      };

      const paintPaceMode = () => {
        view.querySelectorAll('[data-role="pace-mode"] button').forEach((b) => b.classList.toggle('active', b.dataset.mode === paceMode));
        if (paceFixedBox) paceFixedBox.classList.toggle('hidden', paceMode !== 'fixed');
        if (paceRandomMinBox) paceRandomMinBox.classList.toggle('hidden', paceMode !== 'random');
        if (paceRandomMaxBox) paceRandomMaxBox.classList.toggle('hidden', paceMode !== 'random');
      };

      view.querySelectorAll('[data-role="pace-mode"] button').forEach((btn) => {
        btn.onclick = () => {
          paceMode = btn.dataset.mode;
          paintPaceMode();
          refreshPacePreview();
        };
      });

      view.querySelectorAll('[data-role="pace-presets"] [data-preset]').forEach((btn) => {
        btn.onclick = () => {
          const preset = presets.find((p) => p.key === btn.dataset.preset);
          if (!preset) return;
          paceMode = preset.config.mode === 'random' ? 'random' : 'fixed';
          paintPaceMode();
          Object.keys(preset.config).forEach((key) => {
            const el = view.querySelector(`[data-role="${key}"]`);
            if (el) el.value = preset.config[key];
          });
          refreshPacePreview();
          MM.toast(`已套用节奏预设「${preset.label}」，记得点击「保存全部设置」`, 'success', 6000);
        };
      });

      ['intervalSeconds', 'delayMinSeconds', 'delayMaxSeconds', 'burstEvery', 'burstMinSeconds', 'burstMaxSeconds', 'hourlyLimit', 'dailyLimit', 'maxRetries'].forEach((key) => {
        const el = view.querySelector(`[data-role="${key}"]`);
        if (el) el.addEventListener('input', () => refreshPacePreview());
      });
      paintPaceMode();
      refreshPacePreview();

      const collect = () => ({
        senderCompany: view.querySelector('[data-role="senderCompany"]').value.trim(),
        sendMode: mode,
        defaultThrottle: collectThrottle(),
        bounceAutoPause: view.querySelector('[data-role="bounceAutoPause"]').checked,
        bouncePauseThreshold: Number(view.querySelector('[data-role="bouncePauseThreshold"]').value) || 5,
        imapAutoCheck: view.querySelector('[data-role="imapAutoCheck"]').checked,
        imapPollMinutes: Number(view.querySelector('[data-role="imapPollMinutes"]').value) || 5,
        imapAutoMarkBounce: view.querySelector('[data-role="imapAutoMarkBounce"]').checked,
        imapBounceType: view.querySelector('[data-role="imapBounceType"]').value,
        appendFooter: view.querySelector('[data-role="appendFooter"]').checked,
        footerText: view.querySelector('[data-role="footerText"]').value,
        logRetentionDays: Number(view.querySelector('[data-role="logRetentionDays"]').value) || 0,
      });

      view.querySelector('[data-act="goto-accounts"]').onclick = () => MM.navigate('accounts');
      view.querySelector('[data-act="goto-bounce"]').onclick = () => MM.navigate('bounce');

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
