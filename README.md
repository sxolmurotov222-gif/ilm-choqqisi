# ILM CHO‘QQISI — internet orqali ishlaydigan versiya

## Muhim: bir xil Wi‑Fi shart emas

Bu loyiha **umumiy internetdagi bitta serverga** joylashtirilgandan keyin ishlaydi. Har bir o‘quvchi o‘z uyidan yoki boshqa internet/Wi‑Fi tarmog‘idan bitta ommaviy HTTPS havolani ochadi. `localhost:3000` faqat server o‘rnatilgan kompyuterning o‘zida ochiladi; ZIP faylning o‘zi saytni internetga chiqarmaydi.

## Internetga chiqarish (Render)

Ushbu papkada `Dockerfile` va `render.yaml` bor. `render.yaml` doimiy disk talab qiladigan pullik xizmatni sozlaydi, chunki akkauntlar, chatlar va reyting natijalari SQLite bazasida saqlanadi. Bepul, vaqtinchalik diskli hosting qayta ishga tushganda ma’lumotlarni yo‘qotishi mumkin.

1. ZIP faylni oching va loyihani GitHub repository sifatida yuklang. `.env`, `data/` va maxfiy kalitlarni hech qachon GitHubga yuklamang.
2. Render hisobiga kiring va **New → Blueprint** orqali shu repositoryni tanlang.
3. Render so‘ragan `OWNER_PHONE` va `OWNER_PASSWORD` qiymatlarini kiriting. Kuchli, boshqa joyda ishlatilmagan parol tanlang.
4. Deploy tugashini kuting. Render bergan `https://....onrender.com` havolasi — barcha o‘quvchilar foydalanadigan umumiy sayt.
5. Kamida ikki alohida qurilma va alohida internet tarmog‘idan ro‘yxatdan o‘tib sinab ko‘ring.

**Eslatma:** Render hosting va doimiy disk pullik bo‘lishi mumkin. Men bu chat ichidan sizning hosting hisobingizga kirib saytni ommaviy internetga joylashtira olmayman; deployni hosting hisobingizda bajarish kerak.

## Kompyuterda sinash

Talab: Node.js 22.13 yoki undan yangi.

Windows PowerShell:

```powershell
copy .env.example .env
```

`.env` faylida `OWNER_PHONE` va `OWNER_PASSWORD` ni kiriting, so‘ng:

```powershell
npm.cmd start
```

Brauzerda `http://localhost:3000` ni oching. Bu lokal sinov uchun, boshqa internetdagi o‘quvchilar uchun emas.

## Funksiyalar va cheklovlar

- Reyting va har bir sinf TOP-3 ro‘yxati serverdagi SQLite foydalanuvchi natijalaridan hisoblanadi.
- Chat qidiruvi nikning qismi, ism/familiya yoki telefon orqali qidiradi; sinflararo yozishish bloklanmagan.
- Chat xabarlari va akkaunt ma’lumotlari server bazasida saqlanadi.
- Xabar kelishi uchun suhbat oynasi ochiq bo‘lsa, sahifa xabarlarni davriy tekshiradi.
- Bir nechta hosting nusxasini ishga tushirmang: hozirgi loyiha SQLite va server sessiyalaridan foydalanadi.
- Online chat/reyting internet orqali ishlashi uchun barcha foydalanuvchilar aynan bir xil joylashtirilgan sayt URL manzilidan foydalanishi kerak; bir xil Wi‑Fi shart emas.

## Test

```powershell
npm.cmd test
```

Avtomatik testlar mavjud server xavfsizligi, ro‘yxatdan o‘tish, coin va bazadagi saqlanishni tekshiradi. Ular turli internet tarmoqlaridagi to‘liq brauzer sinovining o‘rnini bosmaydi.
