import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountLayout, AdminLayout, PublicLayout } from './components/layouts';
import { AdminAuthProvider, CustomerAuthProvider } from './lib/auth';
import { SettingsProvider } from './lib/settings';
import { ToastProvider } from './lib/toast';
import { AdminForgotPasswordPage, AdminLoginPage, AdminResetPasswordPage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import { BookingPage } from './pages/Booking';
import { GuestManagePage } from './pages/GuestManage';
import { AboutPage, ContactPage, FaqPage, GalleryPage, Home, ReviewsPage, ServicesPage } from './pages/Public';
import { AppointmentDetail, AppointmentsPage, ConfirmationPage, MessagesPage, NotificationsPage, Overview, ProfilePage } from './pages/account/Account';
import { AppointmentDetailAdmin, AppointmentsList, CalendarPage, Dashboard, NewBooking } from './pages/admin/Bookings';
import { AdminProfile, CustomersAdmin, CustomerDetail, FaqsAdmin, GalleryAdmin, MessagesAdmin, NotificationsAdmin, ReviewsAdmin, ServicesAdmin, SettingsPage, SystemPage } from './pages/admin/Manage';
import { useAdminAuth } from './lib/auth';

function AdminOnly({ children }: { children: JSX.Element }) { const { user } = useAdminAuth(); return user?.role === 'admin' ? children : <Navigate to="/admin" replace />; }
function NotFound() { return <div className="wrap section narrow"><h1>Page not found</h1><p className="muted">That page doesn’t exist. <a href="/">Go home</a></p></div>; }

export default function App() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <CustomerAuthProvider>
          <AdminAuthProvider>
            <Routes>
              <Route element={<PublicLayout />}>
                <Route index element={<Home />} />
                <Route path="services" element={<ServicesPage />} />
                <Route path="gallery" element={<GalleryPage />} />
                <Route path="reviews" element={<ReviewsPage />} />
                <Route path="about" element={<AboutPage />} />
                <Route path="faq" element={<FaqPage />} />
                <Route path="contact" element={<ContactPage />} />
                <Route path="book" element={<BookingPage />} />
                <Route path="login" element={<LoginPage />} />
                <Route path="register" element={<RegisterPage />} />
                <Route path="forgot-password" element={<ForgotPasswordPage />} />
                <Route path="reset-password" element={<ResetPasswordPage />} />
                <Route path="booking/manage/:token" element={<GuestManagePage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="account" element={<AccountLayout />}>
                <Route index element={<Overview />} />
                <Route path="appointments" element={<AppointmentsPage />} />
                <Route path="appointments/:id" element={<AppointmentDetail />} />
                <Route path="appointments/:id/confirmation" element={<ConfirmationPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="profile" element={<ProfilePage />} />
              </Route>
              {/* Admin login lives at an unlinked URL; no public page links here. */}
              <Route path="admin/login" element={<AdminLoginPage />} />
              <Route path="admin/forgot-password" element={<AdminForgotPasswordPage />} />
              <Route path="admin/reset-password" element={<AdminResetPasswordPage />} />
              <Route path="admin" element={<AdminLayout />}>
                <Route index element={<Dashboard />} />
                <Route path="appointments" element={<AppointmentsList />} />
                <Route path="appointments/:id" element={<AppointmentDetailAdmin />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="bookings/new" element={<NewBooking />} />
                <Route path="services" element={<ServicesAdmin />} />
                <Route path="customers" element={<CustomersAdmin />} />
                <Route path="customers/:id" element={<CustomerDetail />} />
                <Route path="reviews" element={<ReviewsAdmin />} />
                <Route path="gallery" element={<GalleryAdmin />} />
                <Route path="faqs" element={<FaqsAdmin />} />
                <Route path="messages" element={<MessagesAdmin />} />
                <Route path="notifications" element={<NotificationsAdmin />} />
                <Route path="profile" element={<AdminProfile />} />
                <Route path="settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
                <Route path="system" element={<AdminOnly><SystemPage /></AdminOnly>} />
              </Route>
            </Routes>
          </AdminAuthProvider>
        </CustomerAuthProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}
