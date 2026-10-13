/* 页面：推广邮件列表 */
(function () {
  const MM = window.MM;

  const state = {
    keyword: '',
    tag: '',
    status: 'active',
    selected: new Set(),
    rows: [],
    tags: [],
  };

  async function load(view) {
    const res = await MM.api.listContacts({ keyword: state.keyword, tag: state.tag || undefined, status: state.status });
    state.rows = res.ok ? res.data.items : [];
    state.tags = res.ok ? res.data.tags : [];
    return res;
  }

  function summaryRow(rows) {
    const s = rows.reduce(
      (acc, c) => {
        acc.success += c.stats?.success || 0;
        acc.failed += c.stats?.failed || 0;
        acc.bounced += c.stats?.bounced || 0;
        return acc;
      },
      { success: 0, failed: 0, bounced: 0 },
    );
    return s;
  }

  function tableHtml(rows) {
    if (!rows.length) {
      return `<div class="empty"><strong>没有符合条件的联系人</strong>点击右上角「新增联系人」或「导入 CSV」批量添加推广名单。</div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead>
        <tr>
          <th style="width:34px"><input type="checkbox" data-check-all /></th>
          <th>公司名</th>
          <th>联系人</th>
          <th>称呼</th>
          <th>邮件地址</th>
          <th>电话</th>
          <th>标签</th>
          <th class="num">成功</th>
          <th class="num">失败</th>
          <th class="num">退信</th>
          <th>最近投递</th>
          <th style="width:170px"></th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (c) => `<tr data-id="${c.id}">
              <td><input type="checkbox" data-row-check ${state.selected.has(c.id) ? 'checked' : ''} /></td>
              <td>
                <span class="cell-strong">${MM.esc(c.company || '—')}</span>
                <span class="cell-sub">${MM.esc([c.position, c.city].filter(Boolean).join(' · ') || '—')}</span>
              </td>
              <td>${MM.esc(c.contact || '—')}${c.subscribed === false ? ' <span class="badge badge-bounced">已停用</span>' : ''}</td>
              <td>${MM.esc(c.salutation || '—')}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(c.email)}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(c.phone || '—')}</td>
              <td>${MM.tagList(c.tags)}</td>
              <td class="num" style="color:var(--success)">${c.stats?.success || 0}</td>
              <td class="num" style="color:${c.stats?.failed ? 'var(--danger)' : 'var(--text-faint)'}">${c.stats?.failed || 0}</td>
              <td class="num" style="color:${c.stats?.bounced ? 'var(--warn)' : 'var(--text-faint)'}">${c.stats?.bounced || 0}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">
                ${c.lastSentAt ? `${MM.esc(MM.fmtTimeShort(c.lastSentAt))} ${MM.statusBadge(c.lastStatus)}` : '—'}
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-sm btn-ghost" data-action="edit">编辑</button>
                  <button class="btn btn-sm btn-ghost" data-action="bounce" title="手动标记为退信">退信</button>
                  <button class="btn btn-sm btn-danger" data-action="remove">删除</button>
                </div>
              </td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
  }

  function contactForm(contact) {
    const c = contact || {};
    return `
      <div class="form-grid">
        <div class="field">
          <label class="field-label">公司名<span class="req">*</span></label>
          <input class="input" name="company" value="${MM.attr(c.company)}" placeholder="例：深圳市云图智能科技有限公司" />
        </div>
        <div class="field">
          <label class="field-label">联系人</label>
          <input class="input" name="contact" value="${MM.attr(c.contact)}" placeholder="例：张明远" />
        </div>
        <div class="field">
          <label class="field-label">邮件称呼 <span class="field-hint">（模板中 {{称呼}} 使用）</span></label>
          <input class="input" name="salutation" value="${MM.attr(c.salutation)}" placeholder="例：张总 / 李经理 / 王工" />
        </div>
        <div class="field">
          <label class="field-label">邮件地址<span class="req">*</span></label>
          <input class="input" name="email" value="${MM.attr(c.email)}" placeholder="name@company.com" />
        </div>
        <div class="field">
          <label class="field-label">电话</label>
          <input class="input" name="phone" value="${MM.attr(c.phone)}" placeholder="例：13800000000" />
        </div>
        <div class="field">
          <label class="field-label">职位</label>
          <input class="input" name="position" value="${MM.attr(c.position)}" placeholder="例：采购总监" />
        </div>
        <div class="field">
          <label class="field-label">城市</label>
          <input class="input" name="city" value="${MM.attr(c.city)}" placeholder="例：深圳" />
        </div>
        <div class="field">
          <label class="field-label">标签 <span class="field-hint">（多个用 | 或 、分隔）</span></label>
          <input class="input" name="tags" value="${MM.attr((c.tags || []).join('|'))}" placeholder="重点客户|华东" />
        </div>
        <div class="field span-2">
          <label class="field-label">备注</label>
          <textarea class="textarea" name="remark" rows="2" placeholder="跟进情况、来源渠道等">${MM.esc(c.remark || '')}</textarea>
        </div>
        <div class="field span-2">
          <label class="switch"><input type="checkbox" name="subscribed" ${c.subscribed !== false ? 'checked' : ''} /><span class="track"></span>纳入推广（取消勾选后该地址不再收到任何推广邮件）</label>
        </div>
      </div>`;
  }

  MM.pages.contacts = {
    title: '推广邮件列表',

    async render(view) {
      await MM.loadSettings();
      await load(view);
      const s = summaryRow(state.rows);

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            维护推广目标名单。公司名、联系人、称呼、电话等字段可在邮件模板中通过 <span class="mono">{{变量}}</span> 自动插入，
            每次投递都会按收件人自动替换，并实时累计该地址的成功 / 失败 / 退信次数。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="import">导入 CSV</button>
            <button class="btn" data-act="export">导出 CSV</button>
            <button class="btn btn-primary" data-act="create">＋ 新增联系人</button>
          </div>
        </div>

        <div class="cards c4">
          ${MM.statCard({ label: '名单总数', value: state.rows.length, sub: `筛选结果 / 全库 ${MM.state.overview ? MM.state.overview.userCount : '—'}` })}
          ${MM.statCard({ label: '当前筛选成功数', value: s.success, sub: '统计累计成功投递', tone: 's-success' })}
          ${MM.statCard({ label: '当前筛选失败数', value: s.failed, sub: '含临时性失败', tone: 's-danger' })}
          ${MM.statCard({ label: '当前筛选退信数', value: s.bounced, sub: '退信地址已自动停用', tone: 's-warn' })}
        </div>

        <div class="toolbar">
          <input class="input grow" placeholder="搜索公司名 / 联系人 / 邮箱 / 电话 / 标签…" value="${MM.attr(state.keyword)}" data-role="keyword" />
          <select class="select" data-role="tag">
            <option value="">全部标签</option>
            ${state.tags.map((t) => `<option value="${MM.attr(t)}" ${state.tag === t ? 'selected' : ''}>${MM.esc(t)}</option>`).join('')}
          </select>
          <select class="select" data-role="status">
            <option value="active" ${state.status === 'active' ? 'selected' : ''}>仅可发送</option>
            <option value="all" ${state.status === 'all' ? 'selected' : ''}>全部</option>
            <option value="hasBounce" ${state.status === 'hasBounce' ? 'selected' : ''}>有退信记录</option>
            <option value="unsubscribed" ${state.status === 'unsubscribed' ? 'selected' : ''}>已停用</option>
          </select>
          <div class="spacer"></div>
          <span class="pill">已选 <b data-role="sel-count">${state.selected.size}</b> 项</span>
          <button class="btn btn-sm btn-danger" data-act="bulk-remove" ${state.selected.size ? '' : 'disabled'}>批量删除</button>
        </div>

        <div class="panel"><div class="panel-body tight" data-role="table">${tableHtml(state.rows)}</div></div>
      `;

      const rerenderTable = () => {
        view.querySelector('[data-role="table"]').innerHTML = tableHtml(state.rows);
        bindTable();
      };

      const reload = async () => {
        await load(view);
        rerenderTable();
        view.querySelector('[data-role="sel-count"]').textContent = state.selected.size;
        const s2 = summaryRow(state.rows);
        view.querySelectorAll('.stat-value')[0].textContent = MM.fmtNumber(state.rows.length);
        view.querySelectorAll('.stat-value')[1].textContent = MM.fmtNumber(s2.success);
        view.querySelectorAll('.stat-value')[2].textContent = MM.fmtNumber(s2.failed);
        view.querySelectorAll('.stat-value')[3].textContent = MM.fmtNumber(s2.bounced);
      };

      const bindTable = () => {
        const table = view.querySelector('[data-role="table"]');
        const checkAll = table.querySelector('[data-check-all]');
        if (checkAll) {
          checkAll.checked = state.rows.length > 0 && state.selected.size === state.rows.length;
          checkAll.onchange = () => {
            state.selected.clear();
            if (checkAll.checked) state.rows.forEach((c) => state.selected.add(c.id));
            rerenderTable();
            view.querySelector('[data-role="sel-count"]').textContent = state.selected.size;
            const bulk = view.querySelector('[data-act="bulk-remove"]');
            bulk.disabled = !state.selected.size;
          };
        }
        table.querySelectorAll('tr[data-id]').forEach((tr) => {
          const id = tr.dataset.id;
          const checkbox = tr.querySelector('[data-row-check]');
          checkbox.onchange = () => {
            if (checkbox.checked) state.selected.add(id);
            else state.selected.delete(id);
            view.querySelector('[data-role="sel-count"]').textContent = state.selected.size;
            view.querySelector('[data-act="bulk-remove"]').disabled = !state.selected.size;
          };
          tr.querySelectorAll('[data-action]').forEach((btn) => {
            btn.onclick = async () => {
              const contact = state.rows.find((c) => c.id === id);
              if (btn.dataset.action === 'edit') openEditor(contact, reload);
              if (btn.dataset.action === 'remove') {
                const yes = await MM.confirm({
                  title: '删除联系人',
                  message: `确定要删除 <b>${MM.esc(contact.company)}</b>（${MM.esc(contact.email)}）吗？该操作不可恢复。`,
                  confirmText: '删除',
                  danger: true,
                });
                if (yes) {
                  await MM.api.removeContacts([id]);
                  state.selected.delete(id);
                  MM.toast('已删除该联系人', 'success');
                  await reload();
                }
              }
              if (btn.dataset.action === 'bounce') {
                const note = window.prompt('标记为退信的原因（可留空）：', '手动标记');
                if (note === null) return;
                const res = await MM.api.markContactBounced({ id, note });
                if (res.ok) {
                  MM.toast('已标记为退信并停用该地址', 'warn');
                  await reload();
                } else MM.toast(res.error, 'error');
              }
            };
          });
        });
      };

      bindTable();

      // 筛选
      let timer = null;
      view.querySelector('[data-role="keyword"]').oninput = (e) => {
        state.keyword = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(reload, 260);
      };
      view.querySelector('[data-role="tag"]').onchange = (e) => {
        state.tag = e.target.value;
        reload();
      };
      view.querySelector('[data-role="status"]').onchange = (e) => {
        state.status = e.target.value;
        reload();
      };

      view.querySelector('[data-act="create"]').onclick = () => openEditor(null, reload);

      view.querySelector('[data-act="bulk-remove"]').onclick = async () => {
        const ids = Array.from(state.selected);
        const yes = await MM.confirm({
          title: '批量删除',
          message: `确定要删除选中的 <b>${ids.length}</b> 个联系人吗？该操作不可恢复。`,
          confirmText: '全部删除',
          danger: true,
        });
        if (!yes) return;
        await MM.api.removeContacts(ids);
        state.selected.clear();
        MM.toast(`已删除 ${ids.length} 个联系人`, 'success');
        await reload();
      };

      view.querySelector('[data-act="export"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '导出中');
        const res = await MM.api.exportContactsCsv({ keyword: state.keyword, tag: state.tag || undefined, status: state.status });
        restore();
        if (res.ok && res.data && !res.data.canceled) MM.toast(`已导出到：${res.data.filePath}`, 'success');
        else if (res.ok || (res.error && !/cancel/i.test(res.error))) MM.toast(res.error || '已取消导出', 'warn');
      };

      view.querySelector('[data-act="import"]').onclick = () => openImport(reload);
    },
  };

  function openEditor(contact, onDone) {
    const ctx = MM.modal({
      title: contact ? '编辑联系人' : '新增联系人',
      size: '',
      body: contactForm(contact),
      footer: `<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-save>保存</button>`,
    });

    ctx.$('[data-cancel]').onclick = ctx.close;
    ctx.$('[data-save]').onclick = async (e) => {
      const restore = MM.spinBtn(e.target, '保存中');
      const data = {};
      ctx.$$('input,textarea').forEach((el) => {
        if (!el.name) return;
        data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      });
      data.tags = String(data.tags || '')
        .split(/[|,、]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (contact) data.id = contact.id;
      const res = await MM.api.saveContact(data);
      restore();
      if (!res.ok) {
        MM.toast(res.error, 'error', 6000);
        return;
      }
      MM.toast(contact ? '联系人已更新' : '联系人已添加', 'success');
      ctx.close();
      onDone();
    };
  }

  function openImport(onDone) {
    const sample = '公司名,联系人,称呼,邮件地址,电话,职位,城市,标签,备注\n深圳市示例科技有限公司,张三,张总,zhangsan@example.com,13800000000,采购总监,深圳,重点客户,展会获取';
    const ctx = MM.modal({
      title: '导入推广名单（CSV）',
      size: '',
      body: `
        <div class="callout">支持的列：公司名、联系人、称呼、邮件地址、电话、职位、城市、标签、备注。列顺序任意，表头名称可识别常见别名；重复邮箱默认跳过。</div>
        <div class="field">
          <label class="field-label">导入方式</label>
          <div class="pill-row">
            <button class="btn" data-file>选择 CSV 文件…</button>
            <button class="btn" data-fill-sample>填入示例数据</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label">或直接粘贴 CSV 文本</label>
          <textarea class="textarea" data-role="csv" rows="9" placeholder="${MM.attr(sample)}"></textarea>
        </div>
        <div class="field">
          <label class="switch"><input type="checkbox" data-role="overwrite" /><span class="track"></span>邮箱重复时覆盖已有联系人信息（默认跳过重复项）</label>
        </div>
        <div data-role="result"></div>`,
      footer: `<button class="btn" data-cancel>关闭</button><button class="btn btn-primary" data-import>开始导入</button>`,
    });

    ctx.$('[data-cancel]').onclick = ctx.close;
    ctx.$('[data-fill-sample]').onclick = () => {
      ctx.$('[data-role="csv"]').value = sample;
    };
    ctx.$('[data-file]').onclick = async () => {
      const mode = ctx.$('[data-role="overwrite"]').checked ? 'overwrite' : 'skip';
      const res = await MM.api.importContactsFile({ mode });
      if (!res.ok) {
        MM.toast(res.error, 'error');
        return;
      }
      const d = res.data;
      if (d.canceled) return;
      ctx.$('[data-role="result"]').innerHTML = `<div class="callout">导入完成：新增 <b>${d.added}</b> · 更新 <b>${d.updated}</b> · 跳过 <b>${d.skipped}</b>${d.errors?.length ? `<br/>${d.errors.map(MM.esc).join('<br/>')}` : ''}</div>`;
      MM.toast(`导入完成：新增 ${d.added} 个联系人`, 'success');
      onDone();
    };
    ctx.$('[data-import]').onclick = async (e) => {
      const text = ctx.$('[data-role="csv"]').value;
      if (!text.trim()) {
        MM.toast('请先选择文件或粘贴 CSV 内容', 'warn');
        return;
      }
      const restore = MM.spinBtn(e.target, '导入中');
      const res = await MM.api.importContactsText({ text, mode: ctx.$('[data-role="overwrite"]').checked ? 'overwrite' : 'skip' });
      restore();
      if (!res.ok) {
        MM.toast(res.error, 'error');
        return;
      }
      const d = res.data;
      ctx.$('[data-role="result"]').innerHTML = `<div class="callout">导入完成：新增 <b>${d.added}</b> · 更新 <b>${d.updated}</b> · 跳过 <b>${d.skipped}</b>${d.errors?.length ? `<br/>${d.errors.map(MM.esc).join('<br/>')}` : ''}</div>`;
      MM.toast(`导入完成：新增 ${d.added} 个联系人`, 'success');
      onDone();
    };
  }
})();
