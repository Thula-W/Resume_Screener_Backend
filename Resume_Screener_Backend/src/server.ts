import 'dotenv/config';
import app from "./app";

const PORT = Number(process.env.PORT|| 8080);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// import app from "./app";

// const PORT = 8080;

// app.listen(PORT, '0.0.0.0', () => {
//   console.log(`Server running on port ${PORT}`);
// });