# 💸 Financial Memory

### Your spending has a story. Find it.

**Financial Memory** is a student-focused expense tracker built to help you understand where your money goes, spot spending patterns, and make more informed everyday decisions.

Instead of drowning you in charts and complicated financial jargon, it focuses on a simple question:

**Where did my money actually go?**

---

## ✨ Features

- 📊 **Spending Dashboard** — See today's spending, your remaining daily budget, and monthly category breakdowns.
- 🗓️ **Monthly History** — Explore recorded expenses and understand your spending over time.
- 🧠 **Ask Financial Memory** — Get answers to supported spending questions using your recorded transaction history.
- 💰 **Daily Budget Context** — Understand your spending in relation to your daily budget.
- ☁️ **Cloud Sync** — Sign in with Google and keep your financial data associated with your account.
- 🔐 **Account Isolation** — Keep account data separate, with guest activity isolated from authenticated accounts.
- 🎨 **Personalization** — Choose light or dark mode and customize the app's background.
- 📱 **Responsive Interface** — Track expenses across desktop and mobile-sized screens.

## 🎯 Why Financial Memory?

Tracking expenses is easy to postpone when an app feels complicated. Financial Memory aims to make reviewing spending more approachable, especially for students managing everyday expenses.

Its guiding principle is simple:

> Financial insights should come from your actual records, not invented numbers.

The app focuses on supported questions that can be answered from recorded transaction data, with honest handling of empty or unsupported results.

## 🛠️ Built With

- **Frontend:** HTML, CSS, JavaScript
- **Build Tool:** Vite
- **Authentication & Database:** Supabase
- **Deployment:** Cloudflare Pages
- **Version Control:** Git and GitHub

## 🚀 Getting Started

### Prerequisites

- Node.js and npm
- A Supabase project configured for the application

### Installation

```bash
git clone https://github.com/RAJ-multi/financial-memory-cloudflare.git
cd financial-memory-cloudflare
npm install
```

Create a local `.env` file using the environment variables expected by the application. Configure your Supabase project, authentication provider, database schema, and access policies according to the project setup.

**Never commit secrets or private environment files.**

### Run locally

```bash
npm run dev
```

### Run tests

```bash
npm test
```

### Production build

```bash
npm run build
```

## 🔒 Privacy & Data Handling

Financial Memory separates guest data from authenticated account data. Signing into an account should load that account's data rather than merge guest expenses into it.

Cloud synchronization depends on the configured Supabase service and its access policies. As with any cloud-connected application, users should understand where their data is stored and protect access to their accounts.

*Google authentication is not the same as end-to-end encryption.*

## 🧪 Project Quality

The project includes automated tests for important cloud-sync and account-lifecycle behavior, including account switching, guest isolation, and read/write failure handling.

The test suite and production build have passed in the development environment. Real-world reliability still depends on the deployed configuration and ongoing testing.

## 🗺️ Scope

Financial Memory is currently focused on student expense tracking and supported spending-history questions.

Potential future directions include additional query types, richer historical analysis, more currency options, and expanded transaction-management capabilities.

These are possible future improvements, not promises about current functionality.

## 👨‍💻 Created By

**Raj** — Student developer exploring practical web development, cloud-backed applications, and AI-assisted development.

Built as a project for the **Build With AI: Basics** hackathon.

---

*Remember your spending. Understand your patterns. Make your next decision with more context.*
