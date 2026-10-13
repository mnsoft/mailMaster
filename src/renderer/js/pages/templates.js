/* 页面：推广邮件内容模板 */
(function () {
  const MM = window.MM;

  const state = { templates: [], fields: null, currentId: null, sampleContactId: null, contacts: [] };

  /** 组装「独立窗口预览」所需的数据（与主界面预览解耦，窗口只负责渲染） */
  function buildWindowPayload(data, extra) {
    const d = data || {};
    const c = d.contact || {};
    const a = d.account || null;
    const rendered = d.rendered || {};
    return {
      templateName: (extra && extra.templateName) || '',
      subject: rendered.subject || '',
      body: rendered.body || '',
      missing: rendered.missing || [],
      contact: {
        company: c.company || '',
        contact: c.contact || '',
        salutation: c.salutation || '',
        email: c.email || '',
        phone: c.phone || '',
      },
      from: a ? { name: a.fromName || a.name || '', email: a.email || '' } : null,
      at: new Date().toISOString(),
      source: (extra && extra.source) || 'template',
    };
  }

  function editorHtml(tpl) {
    const t = tpl || { name: '', subject: '', body: '' };
    return `
      <div class="form-grid c1">
        <div class="field">
          <label class="field-label">模板名称<span class="req">*</span></label>
          <input class="input" data-role="name" value="${MM.attr(t.name)}" placeholder="例：标准产品推广（中文）" />
        </div>
        <div class="field">
          <label class="field-label">邮件主题 <span class="field-hint">（支持变量，如：{{公司名}} · 关于 {{联系人}} 的方案沟通）</span></label>
          <input class="input" data-role="subject" value="${MM.attr(t.subject)}" placeholder="邮件主题行" />
        </div>
        <div class="field">
          <label class="field-label">邮件正文</label>
          <textarea class="textarea" data-role="body" rows="16" placeholder="尊敬的{{称呼}}{{联系人}}，您好！&#10;&#10;关于{{公司名}}……">${MM.esc(t.body)}</textarea>
          <div class="field-hint" data-role="scan">—</div>
        </div>
      </div>

      <div class="panel" style="margin:0 0 16px">
        <div class="panel-head">
          <div class="panel-title">插入变量 <span class="hint">将光标放在正文中需要的位置，点击下方变量即可插入</span></div>
        </div>
        <div class="panel-body">
          <div class="field-label" style="margin-bottom:6px">来自邮件列表的联系人字段</div>
          <div class="var-picker" data-role="contact-vars" style="margin-bottom:14px"></div>
          <div class="field-label" style="margin-bottom:6px">发送时自动生成的全局变量</div>
          <div class="var-picker" data-role="global-vars"></div>
        </div>
      </div>

      <div class="field">
        <label class="field-label">预览使用的样例联系人</label>
        <select class="select" data-role="sample">
          <option value="">（使用内置示例联系人）</option>
          ${state.contacts
            .map((c) => `<option value="${c.id}" ${state.sampleContactId === c.id ? 'selected' : ''}>${MM.esc(c.company)} · ${MM.esc(c.contact)}（${MM.esc(c.email)}）</option>`)
            .join('')}
        </select>
      </div>`;
  }

  function listHtml(currentId) {
    if (!state.templates.length) {
      return `<div class="empty" style="padding:24px 12px"><strong>暂无模板</strong>点击下方按钮创建第一个推广邮件模板。</div>`;
    }
    return `<div class="list-plain">
      ${state.templates
        .map(
          (t) => `<div class="list-row" data-tpl="${t.id}" style="cursor:pointer;${t.id === currentId ? 'border-color:rgba(76,141,255,.45);background:var(--accent-soft)' : ''}">
            <div class="grow">
              <div class="title">${MM.esc(t.name)}</div>
              <div class="sub">${MM.esc(t.subject || '（无主题）')}</div>
              <div class="sub">更新于 ${MM.esc(MM.fmtDate(t.updatedAt, true))}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-remove="${t.id}">删除</button>
          </div>`,
        )
        .join('')}
    </div>`;
  }

  MM.pages.templates = {
    title: '推广内容模板',

    async render(view) {
      const [templates, fieldsRes, contactsRes] = await Promise.all([
        MM.loadTemplates(),
        state.fields ? Promise.resolve({ ok: true, data: state.fields }) : MM.api.templateFields(),
        MM.api.listContacts({ status: 'active' }),
      ]);
      state.templates = templates;
      if (fieldsRes.ok) state.fields = fieldsRes.data;
      state.contacts = contactsRes.ok ? contactsRes.data.items : [];
      if (!state.currentId || !templates.some((t) => t.id === state.currentId)) {
        state.currentId = templates.length ? templates[0].id : null;
      }

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            在模板中使用 <span class="mono">{{变量}}</span> 编写推广内容，发送时会自动替换为对应收件人的公司名、联系人、称呼、电话等信息。
            变量支持中文名与常见别名（如 <span class="mono">{{公司}}</span>、<span class="mono">{{姓名}}</span>、<span class="mono">{{尊称}}</span>）。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="preview">预览效果</button>
            <button class="btn btn-primary" data-act="new">＋ 新建模板</button>
            <button class="btn btn-success" data-act="save">保存模板</button>
          </div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title" data-role="editor-title">模板内容</div>
              <button class="btn btn-sm btn-ghost" data-act="duplicate">复制为新模板</button>
            </div>
            <div class="panel-body" data-role="editor"></div>
          </div>
          <div class="tpl-col">
            <div class="panel">
              <div class="panel-head">
                <div class="panel-title">已有模板 <span class="hint" data-role="count"></span></div>
              </div>
              <div class="panel-body scroll-y" data-role="list"></div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <div class="panel-title">当前模板预览</div>
                <div class="panel-head-actions">
                  <button class="btn btn-sm btn-ghost" data-act="preview-window" title="在独立窗口中按完整尺寸查看邮件样式">独立窗口预览</button>
                  <button class="btn btn-sm btn-ghost" data-act="refresh-preview">刷新预览</button>
                </div>
              </div>
              <div class="panel-body">
                <div class="pv-sample-line" data-role="preview-label">跟随左侧编辑内容实时刷新</div>
                <div data-role="live-preview">
                  <div class="empty" style="padding:28px 12px">正在生成预览…</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const editor = view.querySelector('[data-role="editor"]');
      const list = view.querySelector('[data-role="list"]');
      const titleEl = view.querySelector('[data-role="editor-title"]');
      const previewBox = view.querySelector('[data-role="live-preview"]');
      const previewLabel = view.querySelector('[data-role="preview-label"]');
      let previewTimer = null;
      let previewSeq = 0;

      const getCurrent = () => state.templates.find((t) => t.id === state.currentId) || null;

      const renderEditor = () => {
        const tpl = getCurrent();
        titleEl.textContent = tpl ? `编辑模板：${tpl.name}` : '新建模板';
        editor.innerHTML = editorHtml(tpl);

        // 变量按钮
        const contactVars = editor.querySelector('[data-role="contact-vars"]');
        (state.fields?.contact || []).forEach((f) => {
          const chip = document.createElement('button');
          chip.className = 'var-chip';
          chip.textContent = `{{${f.label}}}`;
          chip.title = `插入 ${f.label}（英文键名：${f.key}）`;
          chip.onclick = () => insertVar(`{{${f.label}}}`);
          contactVars.appendChild(chip);
        });
        const globalVars = editor.querySelector('[data-role="global-vars"]');
        (state.fields?.global || []).forEach((f) => {
          const chip = document.createElement('button');
          chip.className = 'var-chip global';
          chip.textContent = `{{${f.label}}}`;
          chip.title = f.hint || '';
          chip.onclick = () => insertVar(`{{${f.label}}}`);
          globalVars.appendChild(chip);
        });

        const body = editor.querySelector('[data-role="body"]');
        const subject = editor.querySelector('[data-role="subject"]');
        const sample = editor.querySelector('[data-role="sample"]');
        body.addEventListener('input', () => {
          updateScan();
          schedulePreview();
        });
        body.addEventListener('keyup', updateScan);
        subject.addEventListener('input', () => {
          updateScan();
          schedulePreview();
        });
        if (sample) {
          sample.addEventListener('change', () => {
            state.sampleContactId = sample.value || null;
            renderPreview();
          });
        }
        updateScan();
        // 切换模板 / 新建 / 保存后同步刷新右侧预览
        renderPreview();
      };

      const updateScan = () => {
        const body = editor.querySelector('[data-role="body"]');
        const subject = editor.querySelector('[data-role="subject"]');
        const scanEl = editor.querySelector('[data-role="scan"]');
        if (!body || !scanEl) return;
        MM.api.scanTemplate({ subject: subject.value, body: body.value }).then((res) => {
          const vars = res.ok ? res.data : [];
          if (!vars.length) {
            scanEl.innerHTML = '<span style="color:var(--text-faint)">尚未使用任何变量</span>';
            return;
          }
          scanEl.innerHTML = `已识别变量：${vars
            .map((v) =>
              v.known
                ? `<span class="tag" style="color:#a9c8ff">${MM.esc(v.raw)}</span>`
                : `<span class="tag miss-var" title="未识别的变量，发送时会替换为空">${MM.esc(v.raw)} ⚠</span>`,
            )
            .join('')}`;
        });
      };

      const insertVar = (text) => {
        const body = editor.querySelector('[data-role="body"]');
        const start = body.selectionStart ?? body.value.length;
        const end = body.selectionEnd ?? body.value.length;
        body.value = `${body.value.slice(0, start)}${text}${body.value.slice(end)}`;
        body.focus();
        body.selectionStart = body.selectionEnd = start + text.length;
        updateScan();
      };

      /* ---- 右侧「当前模板预览」：取左侧编辑器当前内容 + 样例联系人，实时渲染 ---- */
      const readEditor = () => ({
        subject: editor.querySelector('[data-role="subject"]')?.value || '',
        body: editor.querySelector('[data-role="body"]')?.value || '',
        sampleId: editor.querySelector('[data-role="sample"]')?.value || null,
      });

      const renderPreview = async () => {
        if (!previewBox) return;
        const { subject, body, sampleId } = readEditor();

        if (!subject.trim() && !body.trim()) {
          previewLabel.textContent = '跟随左侧编辑内容实时刷新';
          previewBox.innerHTML = `<div class="empty" style="padding:28px 12px"><strong>暂无可预览的内容</strong>在左侧填写邮件主题或正文后，这里会显示变量替换后的实际效果。</div>`;
          return;
        }

        const seq = ++previewSeq;
        const res = await MM.api.previewTemplate({ subject, body, contactId: sampleId });
        if (seq !== previewSeq || !previewBox.isConnected) return; // 只采用最后一次请求的结果

        if (!res.ok) {
          previewBox.innerHTML = `<div class="callout danger">${MM.esc(res.error)}</div>`;
          return;
        }

        const { contact, rendered } = res.data;
        previewLabel.innerHTML = `样例联系人 <b>${MM.esc(contact.company)}</b> · ${MM.esc(contact.contact)}`;
        previewBox.innerHTML = `
          <div class="pill-row" style="margin-bottom:10px">
            <span class="pill">公司名 <b>${MM.esc(contact.company)}</b></span>
            <span class="pill">联系人 <b>${MM.esc(contact.contact)}</b></span>
            <span class="pill">称呼 <b>${MM.esc(contact.salutation || '—')}</b></span>
            <span class="pill">电话 <b>${MM.esc(contact.phone || '—')}</b></span>
          </div>
          ${rendered.missing && rendered.missing.length ? `<div class="callout warn">以下变量在样例联系人中没有值，发送时会被替换为空：${rendered.missing.map(MM.esc).join('、')}</div>` : ''}
          <div class="mail-preview">
            <div class="mail-subject">${MM.esc(rendered.subject || '（无主题）')}</div>${MM.esc(rendered.body)}
          </div>`;
      };

      /** 编辑时防抖刷新，避免每次按键都请求主进程 */
      const schedulePreview = () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(renderPreview, 320);
      };

      const renderList = () => {
        list.innerHTML = listHtml(state.currentId);
        view.querySelector('[data-role="count"]').textContent = `共 ${state.templates.length} 个`;
        list.querySelectorAll('[data-tpl]').forEach((row) => {
          row.onclick = (e) => {
            if (e.target.dataset.remove) return;
            state.currentId = row.dataset.tpl;
            renderEditor();
            renderList();
          };
          const removeBtn = row.querySelector('[data-remove]');
          removeBtn.onclick = async (e) => {
            e.stopPropagation();
            const tpl = state.templates.find((t) => t.id === removeBtn.dataset.remove);
            const yes = await MM.confirm({
              title: '删除模板',
              message: `确定删除模板「<b>${MM.esc(tpl.name)}</b>」吗？`,
              confirmText: '删除',
              danger: true,
            });
            if (!yes) return;
            const res = await MM.api.removeTemplate(tpl.id);
            if (!res.ok) {
              MM.toast(res.error, 'error', 6000);
              return;
            }
            state.templates = state.templates.filter((t) => t.id !== tpl.id);
            if (state.currentId === tpl.id) state.currentId = state.templates[0]?.id || null;
            MM.toast('模板已删除', 'success');
            renderEditor();
            renderList();
          };
        });
      };

      const collect = () => ({
        id: state.currentId || undefined,
        name: editor.querySelector('[data-role="name"]').value.trim(),
        subject: editor.querySelector('[data-role="subject"]').value,
        body: editor.querySelector('[data-role="body"]').value,
      });

      view.querySelector('[data-act="save"]').onclick = async (e) => {
        const payload = collect();
        if (!payload.name) {
          MM.toast('请填写模板名称', 'warn');
          return;
        }
        const restore = MM.spinBtn(e.target, '保存中');
        const res = await MM.api.saveTemplate(payload);
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        MM.state.templates = null;
        state.currentId = res.data.id;
        state.templates = await MM.loadTemplates();
        MM.toast('模板已保存', 'success');
        renderEditor();
        renderList();
      };

      view.querySelector('[data-act="new"]').onclick = () => {
        state.currentId = null;
        renderEditor();
        renderList();
      };

      view.querySelector('[data-act="duplicate"]').onclick = async () => {
        const tpl = getCurrent();
        if (!tpl) {
          MM.toast('请先选择一个模板', 'warn');
          return;
        }
        const res = await MM.api.saveTemplate({ name: `${tpl.name} 副本`, subject: tpl.subject, body: tpl.body });
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        state.templates = await MM.loadTemplates();
        state.currentId = res.data.id;
        MM.toast('已复制为新模板', 'success');
        renderEditor();
        renderList();
      };

      view.querySelector('[data-act="preview-window"]').onclick = async (e) => {
        const { subject, body, sampleId } = readEditor();
        if (!subject.trim() && !body.trim()) {
          MM.toast('左侧还没有可预览的内容', 'warn');
          return;
        }
        const restore = MM.spinBtn(e.target, '准备中');
        const res = await MM.api.previewTemplate({ subject, body, contactId: sampleId });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error', 6000);
          return;
        }
        const tpl = getCurrent();
        MM.openMailPreviewWindow(buildWindowPayload(res.data, { templateName: tpl ? tpl.name : '未保存的新模板' }));
      };

      view.querySelector('[data-act="refresh-preview"]').onclick = (e) => {
        const restore = MM.spinBtn(e.target, '生成中');
        renderPreview().finally(restore);
      };

      view.querySelector('[data-act="preview"]').onclick = async (e) => {
        const payload = collect();
        const sample = editor.querySelector('[data-role="sample"]').value || null;
        const restore = MM.spinBtn(e.target, '生成中');
        const res = await MM.api.previewTemplate({
          subject: payload.subject,
          body: payload.body,
          contactId: sample,
        });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        const { contact, rendered } = res.data;
        MM.modal({
          title: `预览：替换后的邮件内容（样例联系人 ${contact.company} · ${contact.contact}）`,
          size: 'wide',
          body: `
            <div class="pill-row" style="margin-bottom:12px">
              <span class="pill">公司名 <b>${MM.esc(contact.company)}</b></span>
              <span class="pill">联系人 <b>${MM.esc(contact.contact)}</b></span>
              <span class="pill">称呼 <b>${MM.esc(contact.salutation || '—')}</b></span>
              <span class="pill">电话 <b>${MM.esc(contact.phone || '—')}</b></span>
            </div>
            ${rendered.missing?.length ? `<div class="callout warn">以下变量在样例联系人中没有值，发送时会被替换为空：${rendered.missing.map(MM.esc).join('、')}</div>` : ''}
            <div class="mail-preview">
              <div class="mail-subject">${MM.esc(rendered.subject || '（无主题）')}</div>${MM.esc(rendered.body)}
            </div>`,
          footer: `
            <button class="btn" data-modal-close>关闭</button>
            <button class="btn btn-primary" data-act="open-window">独立窗口预览</button>`,
          onMount: (ctx) => {
            const winPayload = buildWindowPayload(res.data, { templateName: (getCurrent() || {}).name || '' });
            ctx.$('[data-act="open-window"]').onclick = () => {
              MM.openMailPreviewWindow(winPayload);
            };
          },
        });
      };

      renderEditor();
      renderList();
    },
  };
})();
