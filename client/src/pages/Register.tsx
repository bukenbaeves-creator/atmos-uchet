import { Navigate } from 'react-router-dom';

// Публичная саморегистрация закрыта: пользователей заводит администратор.
export function Register() {
  return <Navigate to="/login" replace />;
}
