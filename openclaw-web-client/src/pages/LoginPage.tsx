export function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-badge">OpenClaw Web UI</div>
        <h1>登录</h1>
        <p className="login-subtitle">
          仅限已接入 Tailscale 的授权设备访问。第一版使用单用户本地密码登录。
        </p>

        <label className="field-label" htmlFor="passphrase">
          Passphrase
        </label>
        <input id="passphrase" className="text-input" type="password" placeholder="输入本地密码" />

        <button className="primary-button" type="button">
          Login
        </button>

        <div className="login-meta">
          <span>Target: Dan-MacBook</span>
          <span>Network: Tailscale</span>
        </div>
      </section>
    </main>
  )
}
