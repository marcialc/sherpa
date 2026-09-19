export const styles = `
:root {
  font-family:
    Inter,
    ui-sans-serif,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color: #1e293b;
  background: #f6f7f9;
  font-synthesis: none;
  line-height: 1.6;
  font-size: 15px;
  --muted: #526176;
  --accent: #1d4ed8;
  --border: #dce2ea;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
a {
  color: var(--accent);
  text-underline-offset: 3px;
}
a:hover {
  text-decoration: underline;
}
button,
input {
  font: inherit;
}
button,
a,
input,
summary {
  -webkit-tap-highlight-color: transparent;
}
a,
button,
input,
summary {
  outline-offset: 4px;
}
:focus-visible {
  outline: 3px solid #2563eb;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: clamp(1.9rem, 4vw, 2.7rem);
  line-height: 1.18;
  letter-spacing: -0.045em;
  color: #142235;
  font-weight: 720;
}
h2 {
  font-size: 1.15rem;
  line-height: 1.4;
  letter-spacing: -0.02em;
}
h3 {
  font-size: 0.95rem;
}
p {
  color: var(--muted);
}
p + p {
  margin-top: 0.7rem;
}
code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.88em;
  background: #edf1f6;
  border-radius: 4px;
  padding: 0.15em 0.35em;
  overflow-wrap: anywhere;
}
.site-header {
  max-width: 1160px;
  margin: auto;
  padding: 24px 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #18273a;
  font-size: 1.35rem;
  font-weight: 750;
  text-decoration: none;
}
.brand:hover {
  text-decoration: none;
}
.brand img {
  display: block;
  width: 37px;
  height: 37px;
  border-radius: 50%;
  flex: none;
}
.brand-divider {
  height: 21px;
  width: 1px;
  background: var(--border);
  margin: 0 7px;
}
.brand-caption {
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--muted);
}
.signed-in {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 0.82rem;
}
.online-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #187652;
  flex: none;
}
main {
  max-width: 1000px;
  padding: 18px 32px 60px;
  margin: auto;
}
.progress {
  display: flex;
  list-style: none;
  padding: 0 0 28px;
  margin: 0 0 32px;
  border-bottom: 1px solid var(--border);
  gap: 12px;
}
.progress li {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #626f80;
  font-size: 0.84rem;
  flex: 1;
}
.progress li:not(:last-child):after {
  content: "";
  height: 1px;
  background: var(--border);
  flex: 1;
  margin: 0 10px;
}
.step-number {
  border: 1px solid #c9d2de;
  border-radius: 50%;
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  flex: none;
  font-size: 0.8rem;
}
.progress .current {
  color: #1d4ed8;
  font-weight: 650;
}
.current .step-number {
  background: #1d4ed8;
  color: white;
  border-color: #1d4ed8;
}
.done .step-number {
  color: #16704f;
  background: #e3f2eb;
  border-color: #cce5d8;
}
.intro {
  margin-bottom: 28px;
  max-width: 740px;
}
.eyebrow {
  display: block;
  font-size: 0.71rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.intro .eyebrow {
  margin-bottom: 11px;
}
.intro > p:last-child {
  font-size: 1.04rem;
  margin-top: 12px;
  max-width: 640px;
}
.card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 3px 8px #162b4610;
  overflow: hidden;
}
.account-picker {
  max-width: 730px;
}
.account-list {
  margin: 0;
  padding: 8px 24px;
  list-style: none;
}
.account-list li + li {
  border-top: 1px solid #e8ecf1;
}
.account-option {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px 4px;
  color: inherit;
  text-decoration: none;
  border-radius: 8px;
}
.account-option:hover {
  background: #f5f8fd;
  text-decoration: none;
}
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 46px;
  height: 46px;
  border: 1px solid #cbd9ed;
  border-radius: 12px;
  background: #ebf1fa;
  color: #274d79;
  font-weight: 700;
  font-size: 1.15rem;
}
.account-name {
  display: grid;
  min-width: 0;
}
.account-name strong {
  font-size: 1.04rem;
  overflow-wrap: anywhere;
}
.account-name > span {
  font-size: 0.82rem;
  color: var(--muted);
}
.continue {
  margin-left: auto;
  white-space: nowrap;
  color: var(--accent);
  font-size: 0.84rem;
  font-weight: 650;
}
.card-note {
  background: #f9fafc;
  border-top: 1px solid #e8ecf1;
  padding: 16px 28px;
  font-size: 0.85rem;
}
.help {
  margin-top: 22px;
  max-width: 730px;
}
.help summary {
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  color: #42526a;
}
.help[open] summary {
  margin-bottom: 12px;
}
.help p {
  font-size: 0.9rem;
}
.help.compact {
  margin-top: 16px;
  background: #f4f7fb;
  border: 1px solid #e3eaf2;
  border-radius: 9px;
  padding: 12px 15px;
}
.help.compact summary {
  font-size: 0.84rem;
}
.help.compact p {
  font-size: 0.84rem;
}
.empty-state {
  padding: 36px;
  max-width: 730px;
}
.illustration {
  width: 65px;
  height: 65px;
  margin-bottom: 20px;
}
.illustration img {
  display: block;
  width: 65px;
  height: 65px;
  border-radius: 50%;
}
.empty-state h2 {
  font-size: 1.35rem;
  margin-bottom: 8px;
}
.empty-state > p {
  max-width: 540px;
}
.instructions {
  padding-left: 22px;
  margin: 22px 0;
  color: var(--muted);
}
.instructions li {
  padding-left: 7px;
  margin: 12px 0;
}
.instructions li::marker {
  color: #274d79;
  font-weight: 650;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 44px;
  padding: 10px 17px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-weight: 620;
  font-size: 0.88rem;
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}
.button:hover {
  text-decoration: none;
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
  box-shadow: 0 2px 3px #16369218;
}
.primary:hover {
  background: #193fad;
}
.secondary {
  background: white;
  color: #23364e;
  border-color: #cbd5e1;
  box-shadow: 0 1px 2px #162b4608;
}
.secondary:hover {
  background: #f1f5fa;
}
.danger {
  color: #a32929;
  background: #fff;
  border-color: #e5bdbd;
}
.danger:hover {
  background: #fff2f2;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 18px;
}
.text-link {
  font-size: inherit;
  font-weight: 550;
}
.small {
  font-size: 0.81rem !important;
  line-height: 1.65;
}
.actions + .small {
  margin-top: 18px;
}
.account-context {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 20px;
  background: #edf2f8;
  border: 1px solid #dbe4ef;
  border-radius: 12px;
  margin-bottom: 24px;
}
.account-context .avatar {
  width: 36px;
  height: 36px;
  font-size: 0.92rem;
  border-radius: 9px;
  background: white;
}
.account-context .eyebrow {
  font-size: 0.62rem;
  letter-spacing: 0.06em;
}
.account-context strong {
  display: block;
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
.account-context > a {
  font-size: 0.8rem;
  margin-left: auto;
  white-space: nowrap;
}
.setup-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 245px;
  gap: 30px;
  align-items: start;
}
.main-column {
  min-width: 0;
}
.main-column > .card + .card {
  margin-top: 20px;
}
.sidebar-note {
  padding: 12px 0;
  color: var(--muted);
}
.sidebar-note h2 {
  font-size: 1.12rem;
  margin: 8px 0 10px;
  color: #21354e;
}
.sidebar-note p {
  font-size: 0.84rem;
  margin-top: 7px;
}
.sidebar-note .eyebrow {
  font-size: 0.65rem;
}
.sidebar-note hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 23px 0;
}
.form-section {
  padding: 26px 28px;
  border-bottom: 1px solid #e6ebf1;
}
.section-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.mini-step {
  width: 25px;
  height: 25px;
  background: #edf2f8;
  color: #345378;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 0.76rem;
  font-weight: 700;
  flex: none;
}
.form-section > p {
  font-size: 0.88rem;
}
.field {
  margin-top: 21px;
}
.field label {
  display: block;
  font-size: 0.88rem;
  font-weight: 650;
  margin-bottom: 5px;
}
.field-help {
  font-size: 0.81rem;
  line-height: 1.6;
  margin-bottom: 9px;
}
.field-help .text-link {
  white-space: normal;
}
input:not([type="hidden"]) {
  display: block;
  width: 100%;
  padding: 11px 12px;
  color: #18273a;
  background: #fff;
  border: 1px solid #becbdb;
  border-radius: 7px;
  min-height: 46px;
  box-shadow: 0 1px 2px #142f4605;
  font-size: 0.91rem;
}
input::placeholder {
  color: #6a7685;
  font-size: 0.84rem;
}
input:focus {
  border-color: #2563eb;
}
input[aria-invalid="true"] {
  border-color: #ba3030;
}
.field-error {
  font-size: 0.8rem;
  color: #a42222;
  margin-top: 7px;
}
.token-settings {
  margin: 16px 0 12px;
  padding: 13px 15px;
  background: #f5f7fa;
  border-radius: 8px;
}
.token-settings div + div {
  margin-top: 10px;
}
.token-settings dt {
  font-size: 0.72rem;
  color: var(--muted);
}
.token-settings dd {
  font-size: 0.84rem;
  font-weight: 600;
  margin: 2px 0 0;
  color: #243b55;
}
.form-footer {
  padding: 24px 28px;
  background: #fafbfd;
}
.form-footer .button {
  width: 100%;
}
.form-footer p {
  margin-top: 12px;
}
.notice {
  border: 1px solid #d6e0ef;
  border-radius: 9px;
  padding: 14px 18px;
  background: #edf3fc;
  margin-bottom: 20px;
  font-size: 0.87rem;
}
.notice.success {
  background: #eaf6ef;
  border-color: #c9e5d3;
  color: #176141;
}
.notice.error {
  margin: 20px 20px 0;
  background: #fff2ef;
  border-color: #ecc9c2;
  color: #982b21;
}
.notice.error p {
  color: #8d3930;
  font-size: 0.83rem;
  margin-top: 5px;
}
.status-badge {
  display: inline-flex;
  background: #e7f3ec;
  border: 1px solid #cce5d8;
  color: #176344;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 0.73rem;
  font-weight: 650;
  margin-bottom: 14px;
}
.next-review {
  padding: 28px;
}
.next-review h2 {
  font-size: 1.45rem;
}
.next-review .instructions {
  font-size: 0.92rem;
}
.saved-details {
  padding: 22px 28px;
}
.saved-details .section-heading {
  justify-content: space-between;
}
.saved-details h2 {
  font-size: 1rem;
}
.quiet-badge {
  font-size: 0.7rem;
  color: var(--muted);
  padding: 2px 7px;
  background: #f1f4f8;
  border-radius: 4px;
}
.saved-values {
  margin: 0 0 12px;
}
.saved-values div {
  margin-top: 10px;
}
.saved-values dt {
  font-size: 0.76rem;
  color: var(--muted);
}
.saved-values dd {
  margin: 2px 0 0;
  font-size: 0.87rem;
  overflow-wrap: anywhere;
}
.edit-settings > summary {
  padding: 20px 28px;
  cursor: pointer;
  font-size: 0.91rem;
  font-weight: 600;
}
.edit-settings[open] > summary {
  border-bottom: 1px solid var(--border);
}
.disconnect {
  padding: 0 4px;
}
.disconnect summary {
  font-weight: 500;
  color: #6a5760;
  font-size: 0.82rem;
}
.disconnect .button {
  margin-top: 15px;
}
.error-page {
  padding: 32px;
}
.error-page h1 {
  font-size: 1.9rem;
  margin-bottom: 12px;
}
.error-page .button {
  margin-top: 24px;
}
.err {
  color: #a32929;
}
.site-footer {
  max-width: 1000px;
  margin: auto;
  padding: 24px 32px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  gap: 15px;
  color: #667183;
  font-size: 0.72rem;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.skip-link {
  position: absolute;
  left: 20px;
  top: -100px;
  background: white;
  padding: 12px;
  z-index: 10;
}
.skip-link:focus {
  top: 10px;
}
@media (max-width: 760px) {
  .site-header {
    padding: 20px 24px;
  }
  .setup-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar-note {
    padding: 0 4px;
  }
  .sidebar-note hr {
    margin: 16px 0;
  }
  .signed-in {
    font-size: 0.73rem;
  }
  main {
    padding: 10px 24px 40px;
  }
  .site-footer {
    padding: 20px 24px;
    flex-direction: column;
    gap: 4px;
  }
  .progress {
    gap: 5px;
    margin-bottom: 26px;
  }
  .progress li {
    gap: 6px;
    font-size: 0.73rem;
  }
  .progress li:not(:last-child):after {
    margin: 0 4px;
  }
  .intro {
    margin-bottom: 24px;
  }
  .sidebar-note > h3:last-of-type,
  .sidebar-note > p:last-of-type {
    display: none;
  }
}
@media (max-width: 440px) {
  .site-header {
    padding: 18px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .signed-in {
    width: 100%;
    padding-left: 3px;
  }
  main {
    padding: 12px 18px 34px;
  }
  .progress li {
    flex-direction: column;
    align-items: flex-start;
    font-size: 0.72rem;
    gap: 7px;
  }
  .progress li:not(:last-child):after {
    display: none;
  }
  .progress {
    padding-bottom: 20px;
  }
  .form-section,
  .form-footer,
  .next-review,
  .saved-details {
    padding: 23px 20px;
  }
  .empty-state {
    padding: 26px 22px;
  }
  .account-list {
    padding: 5px 16px;
  }
  .account-option {
    gap: 10px;
  }
  .avatar {
    width: 39px;
    height: 39px;
  }
  .continue {
    font-size: 0.76rem;
  }
  .account-context {
    padding: 12px;
    gap: 9px;
  }
  .account-context > a {
    font-size: 0.73rem;
  }
  .actions {
    align-items: stretch;
    flex-direction: column;
  }
  .actions .button {
    width: 100%;
  }
  .edit-settings > summary {
    padding: 20px;
  }
  .site-footer {
    padding: 20px 18px;
  }
}
`;
