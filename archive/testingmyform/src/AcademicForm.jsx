
  // src/AcademicForm.jsx
import React, {
    useState,
    useImperativeHandle,
    forwardRef,
    useCallback,
    useEffect,
  } from "react";
  
  // These can be placeholders if you don't have a real Firebase config
  // or you can remove them entirely if not needed.
  const fakeUpload = async (file) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve("https://fake-download-url/" + file.name);
      }, 500);
    });
  };
  
  function AcademicForm(
    {
      subStep,
      formData,
      handleInputChange,
      handleCourseChange,
      addExamDate,
      handleExamFieldChange,
      addNewCourse,
      storePdfLinkInState,
    },
    ref
  ) {
    // Log mount/unmount to see if the form re-mounts on each keystroke
    useEffect(() => {
      console.log("AcademicForm MOUNTED");
      return () => {
        console.log("AcademicForm UNMOUNTED");
      };
    }, []);
  
    const [selectedFiles, setSelectedFiles] = useState([]);
  
    const uploadAllPDFs = useCallback(async () => {
      console.log("uploadAllPDFs called in AcademicForm");
      for (let i = 0; i < formData.courseList.length; i++) {
        const file = selectedFiles[i];
        if (file) {
          const url = await fakeUpload(file);
          storePdfLinkInState(i, url);
        }
      }
    }, [formData.courseList, selectedFiles, storePdfLinkInState]);
  
    useImperativeHandle(ref, () => ({
      uploadAllPDFs,
    }));
  
    const handleFileSelect = (file, courseIndex) => {
      setSelectedFiles((prev) => {
        const updated = [...prev];
        updated[courseIndex] = file;
        return updated;
      });
    };
  
    // For brevity, just show subStep differently:
    return (
      <div style={{ border: "1px solid green", marginTop: 10, padding: 10 }}>
        <h3>AcademicForm subStep = {subStep}</h3>
  
        {subStep === 1 && (
          <div>
            <label>Education Level:</label>
            <input
              type="text"
              value={formData.educationLevel}
              onChange={(e) => handleInputChange(e, "academic.educationLevel")}
            />
          </div>
        )}
  
        {subStep === 2 && (
          <div>
            <label>Course Name:</label>
            <input
              type="text"
              value={formData.courseList[0].courseName}
              onChange={(e) => handleCourseChange(e, 0, "courseName")}
            />
            <label>Upload PDF:</label>
            <input
              type="file"
              onChange={(e) => handleFileSelect(e.target.files[0], 0)}
            />
          </div>
        )}
  
        {subStep === 3 && (
          <div>
            <label>Daily Hours:</label>
            <input
              type="number"
              value={formData.dailyHours}
              onChange={(e) => handleInputChange(e, "academic.dailyHours")}
            />
          </div>
        )}
  
        {subStep === 4 && (
          <div>
            <label>Additional Notes:</label>
            <textarea
              value={formData.additionalNote}
              onChange={(e) => handleInputChange(e, "academic.additionalNote")}
            />
          </div>
        )}
      </div>
    );
  }
  
  export default forwardRef(AcademicForm);