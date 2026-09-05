// expect-count: 2
type SubmitEvent = { readonly currentTarget: HTMLFormElement; preventDefault: () => void };

const LoginPage = () => {
  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const login = formData.get('login');
    const password = new window.FormData(event.currentTarget).get('password');
    return { login, password };
  };
  return <form onSubmit={handleSubmit} />;
};

export default LoginPage;
