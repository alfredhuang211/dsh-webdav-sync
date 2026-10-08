/* dsh-webdav-sync — Browser half（手写产物，无需构建步骤）。
 *
 * 为什么必须写客户端：宿主会为导出了 volatile Config 的插件生成「表单投影」，
 * 但 0.2.0-rc.1 没有任何已发布客户端渲染它（dsh-settings/README.md 原文：
 * "no shipped client does so yet"）。所以配置界面要插件自己提供。
 *
 * 产物形态不是 ESM，而是自注册的 classic script：加载时调用
 * window.__ModuleLoader__.load({ id, factory })，factory 内用注入的 require
 * 走平台模块表（React 等由宿主提供，不要打包进来）。
 * URL 是 combo 路由 /plugins/??<包名>/client.js&rev=<产物哈希>，不是 /plugins/<包名>/client.js。
 *
 * 这里刻意不用 JSX，因此不需要 esbuild/tsdown；改用 JSX/TS 时，加一个
 * 构建脚本把产物包成同样的 factory 外壳即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-webdav-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/webdav-sync'
    var CLIENT_NAME = 'webdav-sync'
    var TITLE = 'WebDAV 同步'

    async function api(path, init) {
      var res = await fetch(API + path, init)
      var body = await res.json().catch(function () { return null })
      if (!res.ok || !body || body.ok !== true) {
        throw new Error((body && body.error && body.error.message) || ('HTTP ' + res.status))
      }
      return body.value
    }
    var post = function (path) { return api(path, { method: 'POST' }) }

    var border = '1px solid var(--dsw-border, #d0d0d0)'
    function inputStyle() {
      return { padding: '6px 8px', borderRadius: '6px', border: border, background: 'transparent', color: 'inherit', fontSize: '13px', width: '100%', boxSizing: 'border-box' }
    }
    function buttonStyle(primary) {
      return { padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', border: border, background: primary ? 'var(--dsw-accent, #4a7dff)' : 'transparent', color: primary ? '#fff' : 'inherit' }
    }
    var muted = { fontSize: '12px', opacity: 0.72 }
    var danger = { fontSize: '12px', color: 'var(--dsw-danger, #d33)' }

    function Field(props) {
      var field = props.field
      var value = props.value
      var onChange = props.onChange
      if (field.type === 'boolean') {
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', fontSize: '13px' } },
          h('input', { type: 'checkbox', checked: Boolean(value), onChange: function (e) { onChange(e.target.checked) } }),
          field.label)
      }
      if (field.type === 'select') {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0' } },
          h('span', { style: muted }, field.label),
          h('select', { value: value === undefined || value === null ? '' : String(value), style: inputStyle(), onChange: function (e) { onChange(e.target.value) } },
            (field.options || []).map(function (o) { return h('option', { key: o.value, value: o.value }, o.label) })))
      }
      if (field.type === 'list') {
        var text = Array.isArray(value) ? value.join('\n') : (value || '')
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0' } },
          h('span', { style: muted }, field.label),
          h('textarea', {
            value: text, rows: 3, style: inputStyle(),
            onChange: function (e) { onChange(e.target.value.split('\n').map(function (s) { return s.trim() }).filter(Boolean)) }
          }))
      }
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '8px 0' } },
        h('span', { style: muted }, field.label),
        h('input', {
          type: field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          placeholder: field.placeholder || '',
          style: inputStyle(),
          onChange: function (e) { onChange(field.type === 'number' ? Number(e.target.value) : e.target.value) }
        }))
    }

    function Row(props) { return h('div', { style: { display: 'flex', gap: '8px', fontSize: '13px', margin: '2px 0' } }, h('span', { style: { ...muted, minWidth: '64px' } }, props.k), h('span', null, props.v)) }

    function DeviceLine(props) {
      var d = props.device
      if (!d) return h('span', null, props.fallback || '未知')
      return h('span', null, (d.label || d.id || '未知') + (d.platform ? '（' + d.platform + '）' : ''))
    }

    function StatusView(props) {
      var s = props.status
      if (!s) return null
      var rows = []
      // 注意：可达 ≠ 能用。remoteUrl 指向的目录不存在时服务器照样可达，
      // 这时必须把 error 一起显示出来，否则界面只有一句"可达"，
      // 用户完全不知道点备份为什么会全部失败。
      var connText = s.reachable ? '可达' : '不可达'
      if (s.reachable && s.remotePathExists === false) connText += '（但目标目录不存在）'
      if (s.error) connText += '：' + s.error
      rows.push(h(Row, { key: 'r', k: '连接', v: connText }))
      rows.push(h(Row, { key: 'd', k: '本机', v: h(DeviceLine, { device: s.device }) }))
      rows.push(h(Row, {
        key: 'rem',
        k: '云端',
        v: '第 ' + (s.remote.generation || 0) + ' 代' +
          (s.remote.updatedAt ? '，' + new Date(s.remote.updatedAt).toLocaleString() : '') +
          (s.remote.device ? ' 由 ' + (s.remote.device.label || s.remote.device.id) + ' 写入' : '') +
          '，' + s.remote.files + ' 个文件'
      }))
      rows.push(h(Row, { key: 'loc', k: '本地', v: s.local.sessions + ' 个会话 / ' + s.local.envFiles + ' 个环境文件' }))
      if (s.comparison) {
        rows.push(h(Row, {
          key: 'cmp',
          k: '差异',
          v: '待上传 ' + s.comparison.push + '，待恢复 ' + s.comparison.pull + '，冲突 ' + (s.comparison.conflict || 0) + '，一致 ' + s.comparison.identical
        }))
      }
      var extra = []
      if (s.conflicts && s.conflicts.length) {
        extra.push(h('div', { key: 'cf', style: { marginTop: '8px' } },
          h('div', { style: danger }, '冲突（' + s.conflicts.length + '）：两端都改过同一文件'),
          s.conflicts.slice(0, 5).map(function (c, i) {
            return h('div', { key: 'c' + i, style: muted }, c.rel + ' — 本机 ' + c.localSide + ' ／ 云端 ' + c.remoteSide + '（按 ' + c.resolvedBy + ' 取 ' + (c.winner === 'local' ? '本机' : '云端') + '）')
          })))
      }
      if (s.inventoryDiff) {
        var d = s.inventoryDiff
        var bits = []
        if (d.added.length) bits.push('云端多 ' + d.added.length + ' 个：' + d.added.slice(0, 3).map(function (p) { return p.name + '@' + (p.version || '?') }).join('、'))
        if (d.removed.length) bits.push('本机多 ' + d.removed.length + ' 个：' + d.removed.slice(0, 3).map(function (p) { return p.name + '@' + (p.version || '?') }).join('、'))
        if (d.changed.length) bits.push('版本不同 ' + d.changed.length + ' 个：' + d.changed.slice(0, 3).map(function (p) { return p.name + ' ' + p.from + ' → ' + p.to }).join('、'))
        if (d.toggled.length) bits.push('开关不同 ' + d.toggled.length + ' 个')
        extra.push(h('div', { key: 'inv', style: { marginTop: '8px' } },
          h('div', { style: muted }, '插件清单对照：' + (bits.length ? bits.join('；') : '一致')),
          s.inventory ? h('div', { style: muted }, '本机 ' + s.inventory.local.plugins + ' 个插件（profile ' + (s.inventory.local.profile || '?') + '）／云端清单生成于 ' + (s.inventory.remote.generatedAt ? new Date(s.inventory.remote.generatedAt).toLocaleString() : '未知')) : null))
      }
      if (s.warnings && s.warnings.length) {
        extra.push(h('div', { key: 'warn', style: { marginTop: '8px' } },
          h('div', { style: muted }, '注意：'),
          s.warnings.slice(0, 5).map(function (w, i) { return h('div', { key: 'w' + i, style: muted }, w.label + '：' + w.warnings.join('、')) })))
      }
      return h('div', { style: { marginTop: '10px', padding: '10px', border: border, borderRadius: '8px' } }, rows.concat(extra))
    }

    function summarize(verb, value) {
      if (!value) return verb + ' 完成'
      if (verb === 'push') {
        var t = '推送完成：上传 ' + value.uploaded + '（会话 ' + value.bySource.sessions.uploaded + '，环境 ' + value.bySource.environment.uploaded + '），未变 ' + value.unchanged + '，本次为第 ' + value.generation + ' 代'
        if (value.conflicts && value.conflicts.length) t += '；冲突 ' + value.conflicts.length
        if (value.sidecars && value.sidecars.length) t += '；已另存云端副本 ' + value.sidecars.length + ' 份'
        if (value.needsPull && value.needsPull.length) t += '；' + value.needsPull.length + ' 项云端更新，需执行恢复'
        return t
      }
      if (verb === 'force') {
        return '已按云端重建：下载 ' + value.downloaded + '，跳过 ' + value.skipped + '，运行中 ' + value.live + (value.backedUp ? '；覆盖前已备份 ' + value.backedUp + ' 份' : '')
      }
      if (verb === 'pull') {
        var p = '恢复完成：下载 ' + value.downloaded + '（会话 ' + value.bySource.sessions.downloaded + '，环境 ' + value.bySource.environment.downloaded + '），跳过 ' + value.skipped + '，运行中 ' + value.live
        if (value.backedUp) p += '；覆盖前已备份 ' + value.backedUp + ' 份'
        if (value.needsPush && value.needsPush.length) p += '；' + value.needsPush.length + ' 项本机较新，需执行备份'
        return p
      }
      if (verb === 'plan') {
        return '预演：待上传 ' + value.toUpload.length + '，待恢复 ' + value.toPull.length + '，冲突 ' + value.conflicts.length + '（策略 ' + value.policy + '）'
      }
      if (verb === 'test') return '连接成功：' + value.url + '（HTTP ' + value.status + '）'
      if (verb === 'install') return value.ok ? '依赖安装完成' : '依赖安装失败：' + value.error
      return verb + ' 完成'
    }

    function SettingsSection() {
      var cfgState = useState({ loading: true, error: null })
      var setCfg = cfgState[1]
      var cfg = cfgState[0]
      var valState = useState({})
      var values = valState[0]
      var setValues = valState[1]
      var fieldState = useState([])
      var fields = fieldState[0]
      var setFields = fieldState[1]
      var pwState = useState(false)
      var hasPassword = pwState[0]
      var setHasPassword = pwState[1]
      var patchState = useState({})
      var patch = patchState[0]
      var setPatch = patchState[1]
      var busyState = useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var logState = useState(null)
      var log = logState[0]
      var setLog = logState[1]
      var statusState = useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]

      function load() {
        setCfg({ loading: true, error: null })
        api('/config').then(function (value) {
          setValues(value.values || {})
          setFields(value.fields || [])
          setHasPassword(Boolean(value.hasPassword))
          setPatch({})
          setCfg({ loading: false, error: null })
        }).catch(function (err) {
          setCfg({ loading: false, error: String(err && err.message || err) })
        })
      }

      useEffect(function () { load() }, [])

      function change(key, value) {
        setValues(function (prev) { var next = Object.assign({}, prev); next[key] = value; return next })
        setPatch(function (prev) { var next = Object.assign({}, prev); next[key] = value; return next })
      }

      function run(verb, path) {
        setBusy(verb)
        setLog(null)
        post(path).then(function (value) {
          setLog({ kind: 'ok', text: summarize(verb, value) })
          if (verb === 'push' || verb === 'pull' || verb === 'plan') return api('/status').then(setStatus).catch(function () {})
          if (verb === 'install') return null
          return null
        }).catch(function (err) {
          setLog({ kind: 'error', text: String(err && err.message || err) })
        }).finally(function () { setBusy(null) })
      }

      function refreshStatus() {
        setBusy('status')
        setLog(null)
        api('/status').then(function (value) {
          setStatus(value)
          setLog(value.error
            ? { kind: 'error', text: value.error }
            : { kind: 'ok', text: value.reachable ? '状态已刷新' : '云端不可达' })
        }).catch(function (err) {
          setLog({ kind: 'error', text: String(err && err.message || err) })
        }).finally(function () { setBusy(null) })
      }

      function save() {
        setBusy('save')
        var effective = Object.assign({}, patch)
        if (values.password) effective.password = values.password
        api('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: effective })
        }).then(function (value) {
          setValues(value.values || {})
          setHasPassword(Boolean(value.hasPassword))
          setPatch({})
          setLog({ kind: 'ok', text: '配置已保存（环境文件同步设置立即生效）' })
        }).catch(function (err) {
          setLog({ kind: 'error', text: String(err && err.message || err) })
        }).finally(function () { setBusy(null) })
      }

      var children = []
      children.push(h('div', { key: 'title', style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, TITLE))
      children.push(h('div', { key: 'hint', style: { fontSize: '12px', opacity: 0.7, marginBottom: '10px' } },
        '同步两个源：会话日志（字节级，按日志头 cwd 落位）与插件环境（依赖声明、版本锁定、插件配置、带版本的插件清单）。每个文件带版本号 + 时间 + 设备溯源；两端都改动时按策略取舍，落败一方默认另存副本。既不删除本机会话，也不触碰 node_modules。'))
      if (cfg.loading) children.push(h('div', { key: 'loading', style: muted }, '读取配置…'))
      if (cfg.error) children.push(h('div', { key: 'err', style: danger }, '读取配置失败：' + cfg.error))
      if (hasPassword) children.push(h('div', { key: 'pw', style: muted }, '已保存密码（不回显）；重新输入即可覆盖。'))

      var groups = []
      var order = []
      fields.forEach(function (f) {
        var g = f.group || '其他'
        if (order.indexOf(g) < 0) { order.push(g); groups.push({ name: g, items: [] }) }
        groups[order.indexOf(g)].items.push(f)
      })
      groups.forEach(function (g) {
        children.push(h('div', { key: 'g-' + g.name, style: { marginTop: '10px' } },
          h('div', { key: 'gt', style: { fontSize: '12px', fontWeight: 600, opacity: 0.85, marginTop: '6px' } }, g.name),
          g.items.map(function (field) {
            return h(Field, { key: field.key, field: field, value: values[field.key], onChange: function (v) { change(field.key, v) } })
          })))
      })

      var buttons = [
        h('button', { key: 'save', style: buttonStyle(true), disabled: busy !== null, onClick: save }, '保存'),
        h('button', { key: 'status', style: buttonStyle(false), disabled: busy !== null, onClick: refreshStatus }, '状态/版本'),
        h('button', { key: 'test', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('test', '/test') } }, '测试连接'),
        h('button', { key: 'plan', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('plan', '/plan') } }, '预演'),
        h('button', { key: 'push', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('push', '/push') } }, '立即备份'),
        h('button', { key: 'pull', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('pull', '/pull') } }, '从云端恢复'),
        h('button', { key: 'force', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('force', '/pull?force=1') } }, '以云端为准'),
        h('button', { key: 'install', style: buttonStyle(false), disabled: busy !== null, onClick: function () { run('install', '/install') } }, '安装依赖')
      ]
      children.push(h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' } }, buttons))
      if (busy) children.push(h('div', { key: 'busy', style: { ...muted, marginTop: '8px' } }, '执行中：' + busy + '…'))
      if (log) children.push(h('div', { key: 'log', style: log.kind === 'error' ? { ...danger, marginTop: '8px', whiteSpace: 'pre-wrap' } : { ...muted, marginTop: '8px', whiteSpace: 'pre-wrap' } }, log.text))
      if (status) children.push(h(StatusView, { key: 'statusview', status: status }))

      return h('div', { style: { padding: '4px 0' } }, children)
    }

    function apply(ctx) {
      try {
        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 60,
              label: function () { return TITLE },
              inject: function () { return {} }
            }, function SettingsSectionSlot() {
              return h(SettingsSection, {})
            })
          })
        }, 'webdav-sync: settings section')
      } catch (err) {
        try { console.error('[webdav-sync] 注册设置页失败', err) } catch (e) { /* ignore */ }
      }
    }

    module.exports = { inject: ['slots'], apply: apply, name: CLIENT_NAME }
    return module.exports
  }
})
