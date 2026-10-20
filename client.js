/**
 * dsh-bilibili-kit — 浏览器半身（设置页分区）。
 *
 * 只做一件事：在「设置」左侧注册一个「B 站字幕工具」分区（slot
 * `settings.section`），分区内容直接 iframe 到宿主同源的面板
 * `/bilibili-kit`，复用面板里的扫码登录 / 查询 / 复制字幕。
 *
 * 为什么用 iframe 而不是重写一套 React UI：面板已经是可用的完整实现，
 * iframe 同源，能直接读写本机登录态，改动面最小、不重复维护两份 UI。
 *
 * 加载约定（与 dsh-custom-provider / dsh-our-free-model 一致）：
 * `window.__ModuleLoader__.load({ id, factory })`，`id` 等于包名；
 * `exports.apply / exports.inject / exports.name` 由 client-modules 宿主侧读取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bilibili-kit',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h } = React

    /** 面板由本插件的 host 半身注册在同源 webserver 上。 */
    const PANEL_PATH = '/bilibili-kit'

    function Section() {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            minHeight: 520,
          },
        },
        h('iframe', {
          key: 'panel',
          src: PANEL_PATH,
          title: 'B 站字幕工具',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: 'calc(100vh - 240px)',
            minHeight: 480,
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 12,
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }),
        h(
          'p',
          { key: 'hint', style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
          '登录态只保存在本机 ~/.dsh/bilibili-kit/，不会上传。如果下方面板显示空白，说明宿主拦了内嵌页面，',
          h('a', { href: PANEL_PATH, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, '在新标签打开'),
          ' 即可。',
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'bilibili-kit',
            order: 40,
            label: () => 'B 站字幕工具',
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'bilibili-kit'
    return module.exports
  },
})
